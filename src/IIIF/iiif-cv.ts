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

// Thresholds
const OPEN_HAND_THRESHOLD = 0.22; // avg fingertip-to-wrist distance (normalized coords)
const PINCH_DEADZONE = 0.03;      // ignore pinch ratio changes smaller than this
const PINCH_MIN = 0.85;           // clamp zoom factor
const PINCH_MAX = 1.15;

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export interface CVCallbacks {
    onStatusChange?: (status: string) => void;
    onPan?: (worldDx: number, worldDy: number) => void;
    onZoom?: (factor: number) => void;
}

export class CVController {
    video: HTMLVideoElement;

    private handLandmarker: HandLandmarker | null = null;
    private stream: MediaStream | null = null;
    running = false;
    gesturesEnabled = true;

    // Tracking state
    private lastWristX?: number;
    private lastWristY?: number;
    private lastPinchDist?: number;

    // Sensitivity
    private panSensitivity: number;

    // Callbacks
    private callbacks: CVCallbacks;

    constructor(video: HTMLVideoElement, callbacks: CVCallbacks, panSensitivity = 800) {
        this.video = video;
        this.callbacks = callbacks;
        this.panSensitivity = panSensitivity;
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
            numHands: 1,
        });

        this.callbacks.onStatusChange?.('Ready');
    }

    /** Start webcam + detection. Set videoOnly=true to skip detection (diagnostic). */
    async start(videoOnly = false): Promise<void> {
        if (this.running) return;

        this.callbacks.onStatusChange?.('Starting webcam...');

        try {
            // No width/height constraints — let the camera use its native resolution.
            // Forcing non-native resolution on Windows can cause Chrome's MediaFoundation
            // pipeline to do expensive software downscaling, throttling frame delivery.
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    frameRate: { ideal: 30 },
                    facingMode: 'user',
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

        // Wait for actual frame data before playing — matches AR site pattern
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

        this.running = true;
        this.resetTracking();

        if (videoOnly) {
            this.callbacks.onStatusChange?.('Video only (no detection)');
        } else {
            this.callbacks.onStatusChange?.('Tracking');
            this.scheduleDetection();
        }
    }

    stop(): void {
        this.running = false;
        if (this.stream) {
            for (const track of this.stream.getTracks()) {
                track.stop();
            }
            this.stream = null;
        }
        this.video.srcObject = null;
        this.resetTracking();
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
        this.lastWristX = undefined;
        this.lastWristY = undefined;
        this.lastPinchDist = undefined;
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
            // Fallback for browsers without requestVideoFrameCallback
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
            const landmarks = result.landmarks && result.landmarks.length > 0
                ? result.landmarks[0]
                : null;

            if (!landmarks) {
                this.resetTracking();
                this.callbacks.onStatusChange?.('No hand');
                return;
            }

            this.processLandmarks(landmarks);
        } catch {
            // Detection failed for this frame, continue
        }
    }

    private processLandmarks(landmarks: Array<{ x: number; y: number; z: number }>): void {
        const wrist = landmarks[WRIST];

        // Check if hand is open (palm) vs closed (fist)
        let totalDist = 0;
        for (const idx of FINGERTIPS) {
            const tip = landmarks[idx];
            const dx = tip.x - wrist.x;
            const dy = tip.y - wrist.y;
            totalDist += Math.sqrt(dx * dx + dy * dy);
        }
        const avgDist = totalDist / FINGERTIPS.length;

        if (avgDist < OPEN_HAND_THRESHOLD) {
            // Closed fist — pause
            this.resetTracking();
            this.callbacks.onStatusChange?.('Fist \u2014 paused');
            return;
        }

        this.callbacks.onStatusChange?.('Tracking');

        // --- Pan (wrist delta) ---
        if (this.lastWristX !== undefined && this.lastWristY !== undefined) {
            // Normalized coords: 0..1, video is mirrored so invert X
            const dx = -(wrist.x - this.lastWristX) * this.panSensitivity;
            const dy = (wrist.y - this.lastWristY) * this.panSensitivity;

            if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                this.callbacks.onPan?.(dx, dy);
            }
        }
        this.lastWristX = wrist.x;
        this.lastWristY = wrist.y;

        // --- Zoom (thumb-index pinch distance) ---
        const thumb = landmarks[THUMB_TIP];
        const index = landmarks[INDEX_TIP];
        const pinchDx = thumb.x - index.x;
        const pinchDy = thumb.y - index.y;
        const pinchDist = Math.sqrt(pinchDx * pinchDx + pinchDy * pinchDy);

        if (this.lastPinchDist !== undefined && this.lastPinchDist > 0) {
            let ratio = pinchDist / this.lastPinchDist;

            if (Math.abs(ratio - 1.0) > PINCH_DEADZONE) {
                ratio = Math.max(PINCH_MIN, Math.min(PINCH_MAX, ratio));
                this.callbacks.onZoom?.(ratio);
            }
        }
        this.lastPinchDist = pinchDist;
    }
}
