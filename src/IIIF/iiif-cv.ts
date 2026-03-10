/**
 * CVController — MediaPipe hand tracking for gesture-based viewer navigation.
 *
 * Gestures:
 * - Open palm: wrist position delta drives panning
 * - Thumb-to-index pinch distance drives zoom
 * - Closed fist: tracking paused
 *
 * Runs MediaPipe on the main thread with VIDEO running mode.
 * Uses requestVideoFrameCallback to sync detection with actual frame delivery.
 * Passes the video element directly to detectForVideo() — no ImageBitmap overhead.
 *
 * Display: Renders webcam feed to a <canvas> via drawImage() instead of displaying
 * the <video> element directly. This bypasses Chrome's compositor layer for the video,
 * which can be throttled on certain hardware/driver combos. AR SDKs use this same approach.
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

// Landmark indices
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_TIP = 12;
const RING_TIP = 16;
const PINKY_TIP = 20;

const FINGERTIPS = [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP];

// Hand skeleton connections (pairs of landmark indices)
const HAND_CONNECTIONS = [
    // Thumb
    [0, 1], [1, 2], [2, 3], [3, 4],
    // Index
    [0, 5], [5, 6], [6, 7], [7, 8],
    // Middle
    [0, 9], [9, 10], [10, 11], [11, 12],
    // Ring
    [0, 13], [13, 14], [14, 15], [15, 16],
    // Pinky
    [0, 17], [17, 18], [18, 19], [19, 20],
    // Palm
    [5, 9], [9, 13], [13, 17],
];

// Thresholds
const PINCH_THRESHOLD = 0.06;       // thumb-to-index distance to detect pinch (normalized)
const ZOOM_DEADZONE = 0.02;         // ignore zoom ratio changes smaller than this

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export interface CVCallbacks {
    onStatusChange?: (status: string) => void;
    onPan?: (worldDx: number, worldDy: number) => void;
    onZoom?: (factor: number) => void;
}

export class CVController {
    /** Hidden video element — data source only, not displayed */
    video: HTMLVideoElement;
    /** Display canvas — webcam feed rendered here via drawImage() */
    displayCanvas: HTMLCanvasElement | null;

    private displayCtx: CanvasRenderingContext2D | null = null;
    private displayRafId = 0;
    private frameReader: ReadableStreamDefaultReader<VideoFrame> | null = null;

    private handLandmarker: HandLandmarker | null = null;
    private stream: MediaStream | null = null;
    running = false;
    gesturesEnabled = true;

    // Tracking state
    private gesture: 'none' | 'pan' | 'zoom' = 'none';
    // Pan state (single-hand pinch)
    private lastPanX?: number;
    private lastPanY?: number;
    // Zoom state (two-hand pinch)
    private zoomBaseDist?: number; // distance between pinch points when zoom started
    // All detected hands' landmarks for drawing
    private allHandLandmarks: Array<Array<{ x: number; y: number; z: number }>> = [];

    // Sensitivity
    private panSensitivity: number;

    // Callbacks
    private callbacks: CVCallbacks;

    constructor(video: HTMLVideoElement, callbacks: CVCallbacks, panSensitivity = 800, displayCanvas?: HTMLCanvasElement) {
        this.video = video;
        this.callbacks = callbacks;
        this.panSensitivity = panSensitivity;
        this.displayCanvas = displayCanvas ?? null;
        if (this.displayCanvas) {
            this.displayCtx = this.displayCanvas.getContext('2d');
        }
    }

    async init(): Promise<void> {
        this.callbacks.onStatusChange?.('Loading model...');

        const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
        this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: MODEL_URL,
                delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numHands: 2,
        });

        this.callbacks.onStatusChange?.('Ready');
    }

    async start(): Promise<void> {
        if (this.running) return;

        this.callbacks.onStatusChange?.('Starting webcam...');

        try {
            // Two-step capture — matches Cosium/EyeBuyDirect pattern.
            // Step 1: "prime" the capture pipeline with a bare request.
            // This initializes MediaFoundation and gets permission in one shot.
            const primeStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: false,
            });
            // Close the priming stream before requesting the real one
            for (const t of primeStream.getTracks()) t.stop();

            // Step 2: Request the actual stream with specific constraints.
            // Bare number values (not {ideal:X}) and no frameRate — matches working AR SDKs.
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    width: 640,
                    height: 480,
                    facingMode: { ideal: 'user' },
                },
            });
        } catch (err: any) {
            if (err?.name === 'NotFoundError') {
                this.callbacks.onStatusChange?.('No webcam found');
            } else if (err?.name === 'NotAllowedError') {
                this.callbacks.onStatusChange?.('Webcam access denied');
            } else {
                this.callbacks.onStatusChange?.('Webcam error');
            }
            throw err;
        }

        this.video.srcObject = this.stream;

        // Wait for frame data before playing
        await new Promise<void>((resolve) => {
            if (this.video.readyState >= 2) {
                resolve();
            } else {
                this.video.addEventListener('loadeddata', () => resolve(), { once: true });
            }
        });
        await this.video.play();

        const track = this.stream.getVideoTracks()[0];
        if (track) {
            const settings = track.getSettings();
            console.log(`Webcam: ${settings.width}x${settings.height} @ ${settings.frameRate}fps`);
        }

        // Size display canvas to match video
        if (this.displayCanvas && this.displayCtx) {
            this.displayCanvas.width = this.video.videoWidth || 320;
            this.displayCanvas.height = this.video.videoHeight || 240;
        }

        this.running = true;
        this.resetTracking();
        this.callbacks.onStatusChange?.('Tracking');
        this.scheduleDetection();
        this.startDisplayLoop();
    }

    stop(): void {
        this.running = false;
        if (this.displayRafId) {
            cancelAnimationFrame(this.displayRafId);
            this.displayRafId = 0;
        }
        if (this.frameReader) {
            this.frameReader.cancel().catch(() => {});
            this.frameReader = null;
        }
        if (this.stream) {
            for (const track of this.stream.getTracks()) {
                track.stop();
            }
            this.stream = null;
        }
        this.video.srcObject = null;
        this.allHandLandmarks = [];
        this.resetTracking();
        // Clear display canvas
        if (this.displayCtx && this.displayCanvas) {
            this.displayCtx.clearRect(0, 0, this.displayCanvas.width, this.displayCanvas.height);
        }
        this.callbacks.onStatusChange?.('Stopped');
    }

    destroy(): void {
        this.stop();
        if (this.handLandmarker) {
            this.handLandmarker.close();
            this.handLandmarker = null;
        }
    }

    private resetTracking(): void {
        this.lastPanX = undefined;
        this.lastPanY = undefined;
        this.zoomBaseDist = undefined;
        this.gesture = 'none';
    }

    /** Draw hand landmarks and skeleton on the display canvas */
    private drawLandmarks(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const colors = ['rgba(0, 255, 128, 0.6)', 'rgba(128, 128, 255, 0.6)'];

        for (let hand = 0; hand < this.allHandLandmarks.length; hand++) {
            const lm = this.allHandLandmarks[hand];

            // Connections (skeleton lines)
            ctx.strokeStyle = colors[hand % colors.length];
            ctx.lineWidth = 2;
            for (const [a, b] of HAND_CONNECTIONS) {
                const ax = (1 - lm[a].x) * w, ay = lm[a].y * h;
                const bx = (1 - lm[b].x) * w, by = lm[b].y * h;
                ctx.beginPath();
                ctx.moveTo(ax, ay);
                ctx.lineTo(bx, by);
                ctx.stroke();
            }

            // Landmark dots
            for (let i = 0; i < lm.length; i++) {
                const x = (1 - lm[i].x) * w;
                const y = lm[i].y * h;
                const isTip = FINGERTIPS.includes(i);

                ctx.beginPath();
                ctx.arc(x, y, isTip ? 4 : 2.5, 0, Math.PI * 2);
                ctx.fillStyle = i === WRIST ? '#ff4444' : isTip ? (hand === 0 ? '#44ff88' : '#8888ff') : '#ffffff';
                ctx.fill();
            }
        }
    }

    /**
     * Pull frames directly from the camera track via MediaStreamTrackProcessor.
     * Completely bypasses the <video> element's decode/compositor pipeline.
     * Falls back to drawImage(video) if the API isn't available.
     */
    private startDisplayLoop(): void {
        if (!this.displayCtx || !this.displayCanvas) return;

        const track = this.stream?.getVideoTracks()[0];

        // Try MediaStreamTrackProcessor (Insertable Streams API)
        if (track && typeof (globalThis as any).MediaStreamTrackProcessor !== 'undefined') {
            console.log('[CV] Using MediaStreamTrackProcessor for frame delivery');
            this.startTrackProcessorLoop(track);
        } else {
            console.log('[CV] Falling back to drawImage(video) for frame delivery');
            this.startDrawImageLoop();
        }
    }

    /** Pull VideoFrames directly from the track — no video element involved */
    private startTrackProcessorLoop(track: MediaStreamTrack): void {
        const ctx = this.displayCtx!;
        const canvas = this.displayCanvas!;

        const processor = new (globalThis as any).MediaStreamTrackProcessor({ track });
        const reader = processor.readable.getReader() as ReadableStreamDefaultReader<VideoFrame>;
        this.frameReader = reader;

        const readFrame = async () => {
            try {
                while (this.running) {
                    const { value: frame, done } = await reader.read();
                    if (done || !this.running) {
                        frame?.close();
                        break;
                    }

                    // Size canvas on first frame
                    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                        canvas.width = frame.displayWidth;
                        canvas.height = frame.displayHeight;
                    }

                    // Mirror horizontally and draw
                    ctx.save();
                    ctx.scale(-1, 1);
                    ctx.drawImage(frame, -canvas.width, 0, canvas.width, canvas.height);
                    ctx.restore();
                    this.drawLandmarks(ctx, canvas.width, canvas.height);

                    frame.close();
                }
            } catch {
                // Reader cancelled on stop, expected
            }
        };

        readFrame();
    }

    /** Fallback: draw from video element buffer */
    private startDrawImageLoop(): void {
        const ctx = this.displayCtx!;
        const canvas = this.displayCanvas!;

        const draw = () => {
            if (!this.running) return;
            if (this.video.readyState >= 2) {
                ctx.save();
                ctx.scale(-1, 1);
                ctx.drawImage(this.video, -canvas.width, 0, canvas.width, canvas.height);
                ctx.restore();
                this.drawLandmarks(ctx, canvas.width, canvas.height);
            }
            this.displayRafId = requestAnimationFrame(draw);
        };

        this.displayRafId = requestAnimationFrame(draw);
    }

    private scheduleDetection(): void {
        if (!this.running) return;

        if ('requestVideoFrameCallback' in this.video) {
            (this.video as any).requestVideoFrameCallback((_now: number, metadata: any) => {
                if (!this.running) return;

                this.detectFrame(metadata.mediaTime * 1000);
                this.scheduleDetection();
            });
        } else {
            requestAnimationFrame(() => {
                if (!this.running) return;
                this.detectFrame(performance.now());
                this.scheduleDetection();
            });
        }
    }

    private detectFrame(timestampMs: number): void {
        if (!this.gesturesEnabled || !this.handLandmarker || this.video.readyState < 2) return;

        try {
            const result = this.handLandmarker.detectForVideo(this.video, timestampMs);
            const hands = result.landmarks;

            if (!hands || hands.length === 0) {
                this.allHandLandmarks = [];
                this.resetTracking();
                this.callbacks.onStatusChange?.('No hand');
                return;
            }

            this.allHandLandmarks = hands;
            this.processHands(hands);
        } catch {
            // Detection failed for this frame, continue
        }
    }

    /** Get pinch midpoint if thumb+index are touching, or null */
    private getPinchPoint(landmarks: Array<{ x: number; y: number; z: number }>): { x: number; y: number } | null {
        const thumb = landmarks[THUMB_TIP];
        const index = landmarks[INDEX_TIP];
        const dist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
        if (dist < PINCH_THRESHOLD) {
            return { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
        }
        return null;
    }

    private processHands(hands: Array<Array<{ x: number; y: number; z: number }>>): void {
        // Check which hands are pinching
        const pinchPoints: { x: number; y: number }[] = [];
        for (const hand of hands) {
            const p = this.getPinchPoint(hand);
            if (p) pinchPoints.push(p);
        }

        if (pinchPoints.length >= 2) {
            // Two-hand pinch = zoom
            const dist = Math.hypot(
                pinchPoints[0].x - pinchPoints[1].x,
                pinchPoints[0].y - pinchPoints[1].y,
            );

            if (this.gesture !== 'zoom') {
                // Zoom just started — record equilibrium distance
                this.gesture = 'zoom';
                this.zoomBaseDist = dist;
                this.lastPanX = undefined;
                this.lastPanY = undefined;
                this.callbacks.onStatusChange?.('Zoom');
            } else if (this.zoomBaseDist !== undefined && this.zoomBaseDist > 0) {
                const ratio = dist / this.zoomBaseDist;
                if (Math.abs(ratio - 1.0) > ZOOM_DEADZONE) {
                    this.callbacks.onZoom?.(ratio);
                    this.zoomBaseDist = dist; // update base for continuous zooming
                }
            }
            return;
        }

        if (pinchPoints.length === 1) {
            // Single-hand pinch = pan
            const p = pinchPoints[0];

            if (this.gesture !== 'pan') {
                this.gesture = 'pan';
                this.lastPanX = p.x;
                this.lastPanY = p.y;
                this.zoomBaseDist = undefined;
                this.callbacks.onStatusChange?.('Pan');
            } else if (this.lastPanX !== undefined && this.lastPanY !== undefined) {
                const panDx = (p.x - this.lastPanX) * this.panSensitivity;
                const panDy = (this.lastPanY - p.y) * this.panSensitivity;

                if (Math.abs(panDx) > 0.5 || Math.abs(panDy) > 0.5) {
                    this.callbacks.onPan?.(panDx, panDy);
                }

                this.lastPanX = p.x;
                this.lastPanY = p.y;
            }
            return;
        }

        // No pinches — idle
        if (this.gesture !== 'none') {
            this.resetTracking();
        }
        this.callbacks.onStatusChange?.('Tracking');
    }
}
