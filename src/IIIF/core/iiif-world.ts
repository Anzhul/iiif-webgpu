import { IIIFImage } from './iiif-image';
import { TileManager } from '../iiif-tile';

export interface WorldPlacement {
    worldX: number;
    worldY: number;
    worldWidth: number;
    worldHeight: number;
}

export class WorldImage {
    readonly image: IIIFImage;
    tileManager: TileManager;
    placement: WorldPlacement;

    constructor(image: IIIFImage, tileManager: TileManager, placement: WorldPlacement) {
        this.image = image;
        this.tileManager = tileManager;
        this.placement = placement;
    }

    /** Scale factor: world units per image pixel */
    get worldPerPixel(): number {
        return this.placement.worldWidth / this.image.width;
    }

    /** Convert image pixel coordinate to world coordinate */
    imageToWorld(imageX: number, imageY: number): { x: number; y: number } {
        const wpp = this.worldPerPixel;
        return {
            x: this.placement.worldX + imageX * wpp,
            y: this.placement.worldY + imageY * wpp,
        };
    }

    /** Convert world coordinate to image pixel coordinate */
    worldToImage(worldX: number, worldY: number): { x: number; y: number } {
        const pixelsPerWorld = this.image.width / this.placement.worldWidth;
        return {
            x: (worldX - this.placement.worldX) * pixelsPerWorld,
            y: (worldY - this.placement.worldY) * pixelsPerWorld,
        };
    }

    /** Get the world-space bounding box */
    getWorldBounds(): { left: number; top: number; right: number; bottom: number } {
        return {
            left: this.placement.worldX,
            top: this.placement.worldY,
            right: this.placement.worldX + this.placement.worldWidth,
            bottom: this.placement.worldY + this.placement.worldHeight,
        };
    }
}

export class World {
    worldImages: Map<string, WorldImage> = new Map();
    worldWidth: number = 1.0;
    worldHeight: number = 1.0;

    addImage(id: string, worldImage: WorldImage): void {
        this.worldImages.set(id, worldImage);
        this.recalculateBounds();
    }

    removeImage(id: string): void {
        this.worldImages.delete(id);
        this.recalculateBounds();
    }

    private recalculateBounds(): void {
        if (this.worldImages.size === 0) {
            this.worldWidth = 1.0;
            this.worldHeight = 1.0;
            return;
        }
        let maxRight = 0;
        let maxBottom = 0;
        for (const wi of this.worldImages.values()) {
            const bounds = wi.getWorldBounds();
            maxRight = Math.max(maxRight, bounds.right);
            maxBottom = Math.max(maxBottom, bounds.bottom);
        }
        this.worldWidth = maxRight;
        this.worldHeight = maxBottom;
    }

    /** Get all world images whose bounds intersect the given world-space rectangle */
    getVisibleImages(left: number, top: number, right: number, bottom: number): WorldImage[] {
        const result: WorldImage[] = [];
        for (const wi of this.worldImages.values()) {
            const b = wi.getWorldBounds();
            if (b.right > left && b.left < right && b.bottom > top && b.top < bottom) {
                result.push(wi);
            }
        }
        return result;
    }
}
