/**
 * Spring animation system based on OpenSeadragon's implementation
 * Provides smooth, physics-based animations that come to rest
 */

export interface SpringConfig {
    initial?: number;
    springStiffness: number;
    animationTime: number;
    exponential?: boolean;
}

export interface SpringValue {
    value: number;
    time: number;
}

export class Spring {
    current: SpringValue;
    target: SpringValue;
    start: SpringValue;
    springStiffness: number;
    animationTime: number;
    private _exponential: boolean;

    constructor(config: SpringConfig) {
        this.springStiffness = config.springStiffness;
        this.animationTime = config.animationTime;
        this._exponential = config.exponential || false;

        const initialValue = config.initial !== undefined ? config.initial : 0;
        const now = performance.now();

        this.current = { value: initialValue, time: now };
        this.target = { value: initialValue, time: now };
        this.start = { value: initialValue, time: now };
    }

    /**
     * Set the target value and animate towards it
     */
    springTo(target: number): void {
        this.start.value = this.current.value;
        this.start.time = this.current.time;
        this.target.value = target;
        this.target.time = this.start.time + this.animationTime * 1000; // Convert to milliseconds
    }

    /**
     * Immediately jump to a value with no animation
     */
    resetTo(target: number): void {
        this.current.value = target;
        this.start.value = target;
        this.target.value = target;
        this.target.time = this.current.time;
    }

    /**
     * Shift both current and target by the same delta
     */
    shiftBy(delta: number): void {
        this.start.value += delta;
        this.target.value += delta;
        this.current.value += delta;
    }

    /**
     * Update the spring animation for the current frame
     * @returns true if still animating, false if at rest
     */
    update(): boolean {
        this.current.time = performance.now();
        
        const currentTime = this.current.time;
        const targetTime = this.target.time;
        const startTime = this.start.time;

        if (currentTime >= targetTime) {
            // Animation complete
            this.current.value = this.target.value;
            return false;
        }

        const elapsed = currentTime - startTime;
        const duration = targetTime - startTime;

        if (duration === 0) {
            this.current.value = this.target.value;
            return false;
        }

        let position = elapsed / duration;

        // Apply spring physics using the transform function
        // This creates the smooth "ease-out" effect
        const stiffness = this.springStiffness;
        position = 1.0 - Math.exp(-position * stiffness);

        if (this._exponential) {
            // Exponential interpolation (for zoom)
            const startValue = Math.log(this.start.value);
            const targetValue = Math.log(this.target.value);
            this.current.value = Math.exp(startValue + (targetValue - startValue) * position);
        } else {
            // Linear interpolation (for pan)
            this.current.value = this.start.value + (this.target.value - this.start.value) * position;
        }

        return true;
    }

    /**
     * Check if the spring is at its target value
     */
    isAtTargetValue(): boolean {
        return this.current.value === this.target.value;
    }
}
