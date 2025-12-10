/**
 * JSMpeg Pipeline Source Extension
 * 
 * Usage:
 * const player = new JSMpeg.Player(m3u8Url, {
 *     source: JSMpeg.Source.Pipeline,
 *     canvas: document.getElementById('canvas'),
 *     minBuffer: 2,
 *     maxBuffer: 5,
 *     segmentDuration: 2000,
 *     proxyUrl: '/proxy?url='
 * });
 */

(function(JSMpeg) {
    'use strict';
    
    if (!JSMpeg) {
        console.error('JSMpeg not found! Load jsmpeg before this extension.');
        return;
    }
    
    // Pipeline Source Constructor
    JSMpeg.Source.Pipeline = function(url, options) {
        this.url = url;
        this.options = options;
        
        // Pipeline config
        this.minBuffer = options.minBuffer || 2;
        this.maxBuffer = options.maxBuffer || 5;
        this.segmentDuration = options.segmentDuration || 2000;
        this.proxyUrl = options.proxyUrl || '/proxy?url=';
        
        // State
        this.destination = null;
        this.established = false;
        this.completed = false;
        this.streaming = true;
        
        // Pipeline state
        this.segmentQueue = [];
        this.processedSegments = {};
        this.nextToProcess = 0;
        this.isProcessing = false;
        this.running = false;
        
        // Stats
        this.stats = {
            currentlyPlaying: -1,
            currentlyProcessing: -1,
            bufferSize: 0,
            totalSegments: 0
        };
        
        // FFmpeg
        this.ffmpeg = null;
        this.ffmpegReady = false;
        
        console.log('[Pipeline] Initialized with config:', {
            minBuffer: this.minBuffer,
            maxBuffer: this.maxBuffer,
            segmentDuration: this.segmentDuration
        });
    };
    
    // Connect to destination (decoder)
    JSMpeg.Source.Pipeline.prototype.connect = function(destination) {
        this.destination = destination;
    };
    
    // Start pipeline
    JSMpeg.Source.Pipeline.prototype.start = function() {
        if (this.running) return;
        
        this.running = true;
        this.established = false;
        
        console.log('[Pipeline] Starting...');
        
        this.initFFmpeg().then(() => {
            console.log('[Pipeline] FFmpeg ready');
            this.startLoader();
            this.startPlayback();
        }).catch(err => {
            console.error('[Pipeline] FFmpeg init failed:', err);
        });
    };
    
    // Initialize FFmpeg
    JSMpeg.Source.Pipeline.prototype.initFFmpeg = async function() {
        if (this.ffmpegReady) return;
        
        if (typeof FFmpeg === 'undefined') {
            throw new Error('FFmpeg not loaded');
        }
        
        this.ffmpeg = FFmpeg.createFFmpeg({
            log: false,
            corePath: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js"
        });
        
        await this.ffmpeg.load();
        this.ffmpegReady = true;
    };
    
    // Fetch with proxy
    JSMpeg.Source.Pipeline.prototype.fetchWithProxy = async function(url, binary) {
        const proxyUrl = this.proxyUrl + encodeURIComponent(url);
        const resp = await fetch(proxyUrl);
        
        if (!resp.ok) {
            throw new Error('Fetch failed: ' + resp.status);
        }
        
        if (binary) {
            return new Uint8Array(await resp.arrayBuffer());
        } else {
            return await resp.text();
        }
    };
    
    // Parse M3U8
    JSMpeg.Source.Pipeline.prototype.parseM3U8 = function(content, baseUrl) {
        const lines = content.split('\n');
        const segments = [];
        const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line && !line.startsWith('#')) {
                let segUrl = line;
                if (!segUrl.startsWith('http')) {
                    segUrl = base + segUrl;
                }
                segments.push({ url: segUrl });
            }
        }
        
        return segments;
    };
    
    // Resolve M3U8 (handle master playlists)
    JSMpeg.Source.Pipeline.prototype.resolveM3U8 = async function(url) {
        const content = await this.fetchWithProxy(url, false);
        
        if (content.includes('#EXT-X-STREAM-INF')) {
            console.log('[Pipeline] Master playlist detected');
            const lines = content.split('\n');
            const base = url.substring(0, url.lastIndexOf('/') + 1);
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line && !line.startsWith('#')) {
                    const variantUrl = line.startsWith('http') ? line : base + line;
                    return await this.resolveM3U8(variantUrl);
                }
            }
        }
        
        return { content, url };
    };
    
    // Convert segment with FFmpeg
    JSMpeg.Source.Pipeline.prototype.convertSegment = async function(segmentData, idx) {
        const inputName = 'segment_' + idx + '.ts';
        const outputName = 'output_' + idx + '.ts';
        
        try {
            this.ffmpeg.FS('writeFile', inputName, segmentData);
            
            await this.ffmpeg.run(
                '-i', inputName,
                '-f', 'mpegts',
                '-codec:v', 'mpeg1video',
                '-s', '640x360',
                '-b:v', '600k',
                '-r', '25',
                '-bf', '0',
                '-q:v', '5',
                '-codec:a', 'mp2',
                '-ar', '48000',
                '-ac', '2',
                '-b:a', '96k',
                outputName
            );
            
            const output = this.ffmpeg.FS('readFile', outputName);
            
            try { this.ffmpeg.FS('unlink', inputName); } catch(e) {}
            try { this.ffmpeg.FS('unlink', outputName); } catch(e) {}
            
            return output;
        } catch (err) {
            console.error('[Pipeline] FFmpeg conversion error:', err);
            return null;
        }
    };
    
    // Segment loader loop
    JSMpeg.Source.Pipeline.prototype.startLoader = async function() {
        while (this.running) {
            try {
                // Check buffer
                if (this.segmentQueue.length >= this.maxBuffer) {
                    console.log('[Pipeline] Buffer full (' + this.segmentQueue.length + '), waiting...');
                    await this.sleep(1000);
                    continue;
                }
                
                // Check if already processing
                if (this.isProcessing) {
                    await this.sleep(100);
                    continue;
                }
                
                // Resolve M3U8
                const resolved = await this.resolveM3U8(this.url);
                const segments = this.parseM3U8(resolved.content, resolved.url);
                
                if (segments.length === 0) {
                    await this.sleep(2000);
                    continue;
                }
                
                // Find new segments
                const newSegments = [];
                for (const seg of segments) {
                    const segKey = seg.url.split('/').pop().split('?')[0];
                    if (!this.processedSegments[segKey]) {
                        newSegments.push(seg);
                        this.processedSegments[segKey] = true;
                    }
                }
                
                if (newSegments.length > 0) {
                    // Process ONE segment
                    const seg = newSegments[0];
                    const segIdx = this.nextToProcess;
                    
                    this.isProcessing = true;
                    this.stats.currentlyProcessing = segIdx;
                    
                    try {
                        console.log('[Pipeline] Downloading #' + segIdx);
                        const data = await this.fetchWithProxy(seg.url, true);
                        
                        console.log('[Pipeline] Converting #' + segIdx);
                        const mpegData = await this.convertSegment(data, segIdx);
                        
                        if (mpegData && this.running) {
                            this.segmentQueue.push({
                                index: segIdx,
                                data: mpegData
                            });
                            
                            this.stats.bufferSize = this.segmentQueue.length;
                            this.stats.totalSegments++;
                            
                            console.log('[Pipeline] Segment #' + segIdx + ' ready (buffer: ' + this.segmentQueue.length + ')');
                            
                            this.nextToProcess++;
                            
                            // Dispatch event
                            if (this.options.onSegmentReady) {
                                this.options.onSegmentReady(this.stats);
                            }
                        }
                    } catch (e) {
                        console.error('[Pipeline] Error processing #' + segIdx + ':', e);
                    }
                    
                    this.isProcessing = false;
                    this.stats.currentlyProcessing = -1;
                }
                
                await this.sleep(100);
                
            } catch (err) {
                console.error('[Pipeline] Loader error:', err);
                this.isProcessing = false;
                await this.sleep(3000);
            }
        }
    };
    
    // Playback loop
    JSMpeg.Source.Pipeline.prototype.startPlayback = async function() {
        // Wait for minimum buffer
        while (this.running && this.segmentQueue.length < this.minBuffer) {
            await this.sleep(100);
        }
        
        console.log('[Pipeline] Starting playback (buffer: ' + this.segmentQueue.length + ')');
        
        let isFirstSegment = true;
        
        while (this.running) {
            // Wait if buffer too low
            if (this.segmentQueue.length < 1) {
                console.warn('[Pipeline] Buffer empty, waiting...');
                await this.sleep(500);
                continue;
            }
            
            const segment = this.segmentQueue.shift();
            this.stats.currentlyPlaying = segment.index;
            this.stats.bufferSize = this.segmentQueue.length;
            
            if (!this.established) {
                this.established = true;
            }
            
            if (this.destination) {
                this.destination.write(segment.data.buffer);
                
                if (isFirstSegment) {
                    console.log('[Pipeline] First segment playing');
                    isFirstSegment = false;
                    await this.sleep(1000);
                } else {
                    console.log('[Pipeline] Playing #' + segment.index + ' (buffer: ' + this.segmentQueue.length + ')');
                    await this.sleep(this.segmentDuration);
                }
                
                // Dispatch event
                if (this.options.onSegmentPlayed) {
                    this.options.onSegmentPlayed(this.stats);
                }
            }
        }
    };
    
    // Resume (compatibility)
    JSMpeg.Source.Pipeline.prototype.resume = function(secondsHeadroom) {
        // Not needed for pipeline
    };
    
    // Destroy
    JSMpeg.Source.Pipeline.prototype.destroy = function() {
        console.log('[Pipeline] Destroying...');
        this.running = false;
        this.destination = null;
        this.segmentQueue = [];
    };
    
    // Helper: sleep
    JSMpeg.Source.Pipeline.prototype.sleep = function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    };
    
    // Get stats
    JSMpeg.Source.Pipeline.prototype.getStats = function() {
        return this.stats;
    };
    
    console.log('[Pipeline] Source extension loaded');
    
})(typeof JSMpeg !== 'undefined' ? JSMpeg : null);
