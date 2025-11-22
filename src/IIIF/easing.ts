/**
 * Simple easing functions library
 * All functions take a time parameter t (0 to 1) and return the eased progress (usually 0 to 1)
 *
 * Naming convention:
 * - In: Starts slow, ends fast (accelerating)
 * - Out: Starts fast, ends slow (decelerating)
 * - InOut: Slow start and end, fast middle
 */

export type EasingFunction = (t: number) => number;

// Linear - no easing, constant speed
export const linear: EasingFunction = (t: number) => t;

// Quadratic easing (power of 2)
export const easeInQuad: EasingFunction = (t: number) => t * t;

export const easeOutQuad: EasingFunction = (t: number) => t * (2 - t);

export const easeInOutQuad: EasingFunction = (t: number) =>
    t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

// Cubic easing (power of 3)
export const easeInCubic: EasingFunction = (t: number) => t * t * t;

export const easeOutCubic: EasingFunction = (t: number) =>
    (--t) * t * t + 1;

export const easeInOutCubic: EasingFunction = (t: number) =>
    t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;

// Quartic easing (power of 4)
export const easeInQuart: EasingFunction = (t: number) => t * t * t * t;

export const easeOutQuart: EasingFunction = (t: number) =>
    1 - (--t) * t * t * t;

export const easeInOutQuart: EasingFunction = (t: number) =>
    t < 0.5 ? 8 * t * t * t * t : 1 - 8 * (--t) * t * t * t;

// Quintic easing (power of 5)
export const easeInQuint: EasingFunction = (t: number) => t * t * t * t * t;

export const easeOutQuint: EasingFunction = (t: number) =>
    1 + (--t) * t * t * t * t;

export const easeInOutQuint: EasingFunction = (t: number) =>
    t < 0.5 ? 16 * t * t * t * t * t : 1 + 16 * (--t) * t * t * t * t;

// Sine easing - smooth, gentle curves
export const easeInSine: EasingFunction = (t: number) =>
    1 - Math.cos((t * Math.PI) / 2);

export const easeOutSine: EasingFunction = (t: number) =>
    Math.sin((t * Math.PI) / 2);

export const easeInOutSine: EasingFunction = (t: number) =>
    -(Math.cos(Math.PI * t) - 1) / 2;

// Exponential easing - very dramatic
export const easeInExpo: EasingFunction = (t: number) =>
    t === 0 ? 0 : Math.pow(2, 10 * t - 10);

export const easeOutExpo: EasingFunction = (t: number) =>
    t === 1 ? 1 : 1 - Math.pow(2, -10 * t);

export const easeInOutExpo: EasingFunction = (t: number) => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    return t < 0.5
        ? Math.pow(2, 20 * t - 10) / 2
        : (2 - Math.pow(2, -20 * t + 10)) / 2;
};

// Circular easing
export const easeInCirc: EasingFunction = (t: number) =>
    1 - Math.sqrt(1 - t * t);

export const easeOutCirc: EasingFunction = (t: number) =>
    Math.sqrt(1 - (--t) * t);

export const easeInOutCirc: EasingFunction = (t: number) =>
    t < 0.5
        ? (1 - Math.sqrt(1 - 4 * t * t)) / 2
        : (Math.sqrt(1 - (-2 * t + 2) * (-2 * t + 2)) + 1) / 2;

// Back easing - goes past the target and comes back (overshoot effect)
export const easeInBack: EasingFunction = (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return c3 * t * t * t - c1 * t * t;
};

export const easeOutBack: EasingFunction = (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export const easeInOutBack: EasingFunction = (t: number) => {
    const c1 = 1.70158;
    const c2 = c1 * 1.525;
    return t < 0.5
        ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
        : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
};

// Elastic easing - spring-like bouncy effect
export const easeInElastic: EasingFunction = (t: number) => {
    const c4 = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4);
};

export const easeOutElastic: EasingFunction = (t: number) => {
    const c4 = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
};

export const easeInOutElastic: EasingFunction = (t: number) => {
    const c5 = (2 * Math.PI) / 4.5;
    return t === 0 ? 0 : t === 1 ? 1 : t < 0.5
        ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
        : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1;
};

// Bounce easing - bouncing ball effect
export const easeOutBounce: EasingFunction = (t: number) => {
    const n1 = 7.5625;
    const d1 = 2.75;

    if (t < 1 / d1) {
        return n1 * t * t;
    } else if (t < 2 / d1) {
        return n1 * (t -= 1.5 / d1) * t + 0.75;
    } else if (t < 2.5 / d1) {
        return n1 * (t -= 2.25 / d1) * t + 0.9375;
    } else {
        return n1 * (t -= 2.625 / d1) * t + 0.984375;
    }
};

export const easeInBounce: EasingFunction = (t: number) =>
    1 - easeOutBounce(1 - t);

export const easeInOutBounce: EasingFunction = (t: number) =>
    t < 0.5
        ? (1 - easeOutBounce(1 - 2 * t)) / 2
        : (1 + easeOutBounce(2 * t - 1)) / 2;

// Helper function to get easing by name
export const easings: Record<string, EasingFunction> = {
    linear,
    easeInQuad,
    easeOutQuad,
    easeInOutQuad,
    easeInCubic,
    easeOutCubic,
    easeInOutCubic,
    easeInQuart,
    easeOutQuart,
    easeInOutQuart,
    easeInQuint,
    easeOutQuint,
    easeInOutQuint,
    easeInSine,
    easeOutSine,
    easeInOutSine,
    easeInExpo,
    easeOutExpo,
    easeInOutExpo,
    easeInCirc,
    easeOutCirc,
    easeInOutCirc,
    easeInBack,
    easeOutBack,
    easeInOutBack,
    easeInElastic,
    easeOutElastic,
    easeInOutElastic,
    easeInBounce,
    easeOutBounce,
    easeInOutBounce,
};

// Helper to apply easing to a value transition
export function interpolate(start: number, end: number, progress: number, easing: EasingFunction = linear): number {
    const easedProgress = easing(progress);
    return start + (end - start) * easedProgress;
}

/**
 * Spring easing function based on OpenSeadragon's implementation
 * Creates smooth, physics-based animation
 *
 * @param stiffness - Controls the curve shape (default: 6.5)
 *                   - Lower values (1-3): Slower, more gradual
 *                   - Higher values (10+): Faster, snappier
 * @returns An easing function
 */
export function createSpringEasing(stiffness: number = 6.5): EasingFunction {
    return (t: number) => {
        if (t === 0) return 0;
        if (t === 1) return 1;
        return (1.0 - Math.exp(stiffness * -t)) / (1.0 - Math.exp(-stiffness));
    };
}

// Default spring easing (OpenSeadragon default stiffness)
export const spring: EasingFunction = createSpringEasing(6.5);
