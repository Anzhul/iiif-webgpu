import { IIIFImage } from './iiif-image';
import type { ImageTransform } from './iiif-transform';
import { CoordinateTransform } from './iiif-transform';

/**
 * Manages the world coordinate system and image placements
 * World coordinates are in pixels
 */
export class WorldSpace {
    private images: Map<string, ImageTransform>;

    constructor() {
        this.images = new Map();
    }

    /**
     * Add an image to the world at a specific position
     * @param id - Unique identifier for the image
     * @param image - IIIF image to place
     * @param worldX - X position in world coordinates (top-left corner)
     * @param worldY - Y position in world coordinates (top-left corner)
     * @param worldZ - Z position for stacking (default: 0)
     * @param scale - Scale relative to native size (default: 1.0)
     * @param rotation - Rotation in radians (default: 0)
     */
    placeImage(
        id: string,
        image: IIIFImage,
        worldX: number = 0,
        worldY: number = 0,
        worldZ: number = 0,
        scale: number = 1.0,
        rotation: number = 0
    ): ImageTransform {
        const transform: ImageTransform = {
            id,
            image,
            worldX,
            worldY,
            worldZ,
            scale,
            rotation,
            displayWidth: image.width * scale,
            displayHeight: image.height * scale
        };

        this.images.set(id, transform);
        return transform;
    }

    /**
     * Remove an image from the world
     */
    removeImage(id: string): boolean {
        return this.images.delete(id);
    }

    /**
     * Get an image transform by ID
     */
    getImageTransform(id: string): ImageTransform | undefined {
        return this.images.get(id);
    }

    /**
     * Get all image transforms
     */
    getAllImageTransforms(): ImageTransform[] {
        return Array.from(this.images.values());
    }

    /**
     * Update an image's position
     */
    updateImagePosition(id: string, worldX: number, worldY: number, worldZ?: number) {
        const transform = this.images.get(id);
        if (transform) {
            transform.worldX = worldX;
            transform.worldY = worldY;
            if (worldZ !== undefined) {
                transform.worldZ = worldZ;
            }
        }
    }

    /**
     * Update an image's scale
     */
    updateImageScale(id: string, scale: number) {
        const transform = this.images.get(id);
        if (transform) {
            transform.scale = scale;
            transform.displayWidth = transform.image.width * scale;
            transform.displayHeight = transform.image.height * scale;
        }
    }

    /**
     * Get images that intersect with a bounding box (for viewport culling)
     * @param bounds - Bounding box in world coordinates
     * @returns Array of image transforms that are visible
     */
    getVisibleImages(bounds: { left: number, top: number, right: number, bottom: number }): ImageTransform[] {
        return Array.from(this.images.values())
            .filter(transform => {
                const imgBounds = CoordinateTransform.getWorldBounds(transform);
                return CoordinateTransform.intersects(bounds, imgBounds);
            })
            .sort((a, b) => a.worldZ - b.worldZ); // Sort by Z order (back to front)
    }

    /**
     * Find which image (if any) contains a world point
     * Returns the topmost image if multiple overlap
     */
    getImageAtPoint(worldX: number, worldY: number): ImageTransform | undefined {
        // Get all images containing the point
        const candidates = Array.from(this.images.values())
            .filter(transform => CoordinateTransform.containsPoint(worldX, worldY, transform));

        // Return the one with highest Z (topmost)
        if (candidates.length === 0) return undefined;
        return candidates.reduce((top, current) =>
            current.worldZ > top.worldZ ? current : top
        );
    }

    /**
     * Convert world coordinates to image-local coordinates
     * @param worldX - X coordinate in world space
     * @param worldY - Y coordinate in world space
     * @param imageId - ID of the target image
     * @returns Point in image-local coordinates, or undefined if image not found
     */
    worldToImage(worldX: number, worldY: number, imageId: string): { x: number, y: number } | undefined {
        const transform = this.images.get(imageId);
        if (!transform) return undefined;
        return CoordinateTransform.worldToImage(worldX, worldY, transform);
    }

    /**
     * Convert image-local coordinates to world coordinates
     * @param imageX - X coordinate in image pixels
     * @param imageY - Y coordinate in image pixels
     * @param imageId - ID of the source image
     * @returns Point in world coordinates, or undefined if image not found
     */
    imageToWorld(imageX: number, imageY: number, imageId: string): { x: number, y: number } | undefined {
        const transform = this.images.get(imageId);
        if (!transform) return undefined;
        return CoordinateTransform.imageToWorld(imageX, imageY, transform);
    }

    /**
     * Calculate world bounds that encompass all images
     * Useful for "fit all" operations
     */
    getWorldBounds(): { left: number, top: number, right: number, bottom: number, width: number, height: number } | null {
        if (this.images.size === 0) return null;

        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        this.images.forEach(transform => {
            const bounds = CoordinateTransform.getWorldBounds(transform);
            minX = Math.min(minX, bounds.left);
            minY = Math.min(minY, bounds.top);
            maxX = Math.max(maxX, bounds.right);
            maxY = Math.max(maxY, bounds.bottom);
        });

        return {
            left: minX,
            top: minY,
            right: maxX,
            bottom: maxY,
            width: maxX - minX,
            height: maxY - minY
        };
    }

    /**
     * Get the center point of all images (useful for camera positioning)
     */
    getWorldCenter(): { x: number, y: number } | null {
        const bounds = this.getWorldBounds();
        if (!bounds) return null;

        return {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2
        };
    }

    // ============================================================================
    // LAYOUT HELPERS
    // ============================================================================

    /**
     * Arrange images in a grid layout
     * @param imageIds - IDs of images to arrange
     * @param columns - Number of columns
     * @param spacing - Spacing between images in pixels
     * @param startX - Starting X position (default: 0)
     * @param startY - Starting Y position (default: 0)
     */
    layoutGrid(imageIds: string[], columns: number, spacing: number = 50, startX: number = 0, startY: number = 0) {
        let x = startX;
        let y = startY;
        let maxHeightInRow = 0;

        imageIds.forEach((id, index) => {
            const transform = this.images.get(id);
            if (!transform) return;

            // Move to next row if needed
            if (index > 0 && index % columns === 0) {
                x = startX;
                y += maxHeightInRow + spacing;
                maxHeightInRow = 0;
            }

            // Position image
            transform.worldX = x;
            transform.worldY = y;

            // Update for next iteration
            x += transform.displayWidth + spacing;
            maxHeightInRow = Math.max(maxHeightInRow, transform.displayHeight);
        });
    }

    /**
     * Arrange two images as a book spread (side by side)
     * @param leftImageId - ID of left page
     * @param rightImageId - ID of right page
     * @param gutterWidth - Width of gutter between pages
     * @param centerX - X position of the gutter center (default: 0)
     * @param centerY - Y position of the spread center (default: 0)
     */
    layoutBookSpread(leftImageId: string, rightImageId: string, gutterWidth: number = 50, centerX: number = 0, centerY: number = 0) {
        const leftTransform = this.images.get(leftImageId);
        const rightTransform = this.images.get(rightImageId);

        if (!leftTransform || !rightTransform) {
            console.warn('One or both images not found for book spread layout');
            return;
        }

        // Position left page
        leftTransform.worldX = centerX - (gutterWidth / 2) - leftTransform.displayWidth;
        leftTransform.worldY = centerY - (leftTransform.displayHeight / 2);

        // Position right page
        rightTransform.worldX = centerX + (gutterWidth / 2);
        rightTransform.worldY = centerY - (rightTransform.displayHeight / 2);
    }

    /**
     * Arrange images horizontally
     */
    layoutHorizontal(imageIds: string[], spacing: number = 50, startX: number = 0, startY: number = 0) {
        let x = startX;

        imageIds.forEach(id => {
            const transform = this.images.get(id);
            if (!transform) return;

            transform.worldX = x;
            transform.worldY = startY;

            x += transform.displayWidth + spacing;
        });
    }

    /**
     * Arrange images vertically
     */
    layoutVertical(imageIds: string[], spacing: number = 50, startX: number = 0, startY: number = 0) {
        let y = startY;

        imageIds.forEach(id => {
            const transform = this.images.get(id);
            if (!transform) return;

            transform.worldX = startX;
            transform.worldY = y;

            y += transform.displayHeight + spacing;
        });
    }
}
