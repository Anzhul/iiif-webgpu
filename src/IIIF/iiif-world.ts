import { IIIFImage } from './iiif-image';

/**
 * Manages the world coordinate system and image placements
 * World coordinates are in pixels
 */


interface GroupRefs {
  id: string,
  children: Set<string>,                // Child IDs (images or groups)
  parent?: string,                      // Parent group ID
  localX?: number, 
  localY?: number, 
  localZ?: number,              // Position relative to parent
  worldX?: number, 
  worldY?: number, 
  worldZ?: number,              // Cached world position
  scale?: number, 
  rotation?: number
}

interface ImageRefs {
  id: string,
  parent?: string,                      // Parent group ID
  localX?: number, 
  localY?: number, 
  localZ?: number,              // Position relative to parent
  worldX?: number, 
  worldY?: number, 
  worldZ?: number,              // Cached world position
  scale?: number, 
  rotation?: number
}

export class WorldSpace {
    private imageRef: Map<string, IIIFImage>;
    private groupRef: Map<string, GroupRefs>;

    constructor() {
        this.imageRef = new Map();
        this.groupRef = new Map();
    }

    getWorldBounds() {
        return { width: 0, height: 0, left: 0, top: 0 };
        //Calculate bounds based on placed images
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
    ){
        //Alter image coordinates
    }

    addImageRef(id: string, image: IIIFImage) {
    }   
}
