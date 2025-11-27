import { IIIFImage } from './iiif-image';

/**
 * Represents the placement and transformation of an image in world space
 */
export interface ImageTransform {
    id: string;
    image: IIIFImage;

    // Position in world coordinates (pixels)
    worldX: number;
    worldY: number;
    worldZ: number;      // Depth layer for stacking (higher = in front)

    // Transform properties
    scale: number;       // Scale relative to native size (1.0 = 100%)
    rotation: number;    // Rotation in radians

    // Display dimensions (after scale applied)
    displayWidth: number;
    displayHeight: number;
}

/**
 * Coordinate conversion utilities
 */
export class CoordinateTransform {
    /**
     * Convert world coordinates to image-local coordinates
     * @param worldX - X coordinate in world space
     * @param worldY - Y coordinate in world space
     * @param transform - Image transform
     * @returns Point in image-local coordinates (image pixels)
     */
    static worldToImage(worldX: number, worldY: number, transform: ImageTransform): { x: number, y: number } {
        // TODO: Add rotation support later
        if (transform.rotation !== 0) {
            console.warn('Rotation not yet supported in coordinate transform');
        }

        // Translate to image-local origin
        const localX = worldX - transform.worldX;
        const localY = worldY - transform.worldY;

        // Scale to image pixels
        const imageX = localX / transform.scale;
        const imageY = localY / transform.scale;

        return { x: imageX, y: imageY };
    }

    /**
     * Convert image-local coordinates to world coordinates
     * @param imageX - X coordinate in image pixels
     * @param imageY - Y coordinate in image pixels
     * @param transform - Image transform
     * @returns Point in world coordinates
     */
    static imageToWorld(imageX: number, imageY: number, transform: ImageTransform): { x: number, y: number } {
        // TODO: Add rotation support later
        if (transform.rotation !== 0) {
            console.warn('Rotation not yet supported in coordinate transform');
        }

        // Scale from image pixels to display size
        const localX = imageX * transform.scale;
        const localY = imageY * transform.scale;

        // Translate to world position
        const worldX = transform.worldX + localX;
        const worldY = transform.worldY + localY;

        return { x: worldX, y: worldY };
    }

    /**
     * Check if a world point is inside an image's bounds
     * @param worldX - X coordinate in world space
     * @param worldY - Y coordinate in world space
     * @param transform - Image transform
     * @returns true if point is inside image bounds
     */
    static containsPoint(worldX: number, worldY: number, transform: ImageTransform): boolean {
        return worldX >= transform.worldX &&
               worldX <= transform.worldX + transform.displayWidth &&
               worldY >= transform.worldY &&
               worldY <= transform.worldY + transform.displayHeight;
    }

    /**
     * Get the world-space bounds of an image
     * @param transform - Image transform
     * @returns Bounding box in world coordinates
     */
    static getWorldBounds(transform: ImageTransform): { left: number, top: number, right: number, bottom: number, width: number, height: number } {
        return {
            left: transform.worldX,
            top: transform.worldY,
            right: transform.worldX + transform.displayWidth,
            bottom: transform.worldY + transform.displayHeight,
            width: transform.displayWidth,
            height: transform.displayHeight
        };
    }

    /**
     * Check if two bounding boxes intersect
     */
    static intersects(
        bounds1: { left: number, top: number, right: number, bottom: number },
        bounds2: { left: number, top: number, right: number, bottom: number }
    ): boolean {
        return !(bounds1.right < bounds2.left ||
                 bounds1.left > bounds2.right ||
                 bounds1.bottom < bounds2.top ||
                 bounds1.top > bounds2.bottom);
    }
}
