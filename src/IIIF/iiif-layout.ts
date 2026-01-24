// Layout system for positioning multiple images on a unified canvas

import { IIIFImage } from './iiif-image';

export type LayoutMode = 'horizontal' | 'vertical' | 'grid' | 'book';

export interface LayoutOptions {
    mode: LayoutMode;
    gap: number;              // Gap between images in pixels
    gridColumns?: number;     // For grid mode: number of columns (auto-calculated if not set)
    alignToTallest?: boolean; // For horizontal: align all images to tallest height
    alignToWidest?: boolean;  // For vertical: align all images to widest width
}

export interface LayoutResult {
    totalWidth: number;
    totalHeight: number;
    images: Array<{
        id: string;
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
}

export class LayoutManager {

    // Calculate layout and set world positions on images
    static layout(images: IIIFImage[], options: LayoutOptions): LayoutResult {
        switch (options.mode) {
            case 'horizontal':
                return this.layoutHorizontal(images, options);
            case 'vertical':
                return this.layoutVertical(images, options);
            case 'grid':
                return this.layoutGrid(images, options);
            case 'book':
                return this.layoutBook(images, options);
            default:
                return this.layoutHorizontal(images, options);
        }
    }

    // Horizontal strip layout (left to right)
    private static layoutHorizontal(images: IIIFImage[], options: LayoutOptions): LayoutResult {
        const { gap, alignToTallest = false } = options;
        const result: LayoutResult = { totalWidth: 0, totalHeight: 0, images: [] };

        // Find tallest image for alignment
        const maxHeight = alignToTallest
            ? Math.max(...images.map(img => img.height || 0))
            : 0;

        let currentX = 0;

        for (const image of images) {
            const width = image.width || 0;
            const height = image.height || 0;

            // Center vertically if aligning to tallest
            const y = alignToTallest ? (maxHeight - height) / 2 : 0;

            image.setWorldPosition(currentX, y, 0);

            result.images.push({
                id: image.id,
                x: currentX,
                y,
                width,
                height
            });

            result.totalHeight = Math.max(result.totalHeight, y + height);
            currentX += width + gap;
        }

        result.totalWidth = currentX - gap; // Remove last gap
        return result;
    }

    // Vertical strip layout (top to bottom)
    private static layoutVertical(images: IIIFImage[], options: LayoutOptions): LayoutResult {
        const { gap, alignToWidest = false } = options;
        const result: LayoutResult = { totalWidth: 0, totalHeight: 0, images: [] };

        // Find widest image for alignment
        const maxWidth = alignToWidest
            ? Math.max(...images.map(img => img.width || 0))
            : 0;

        let currentY = 0;

        for (const image of images) {
            const width = image.width || 0;
            const height = image.height || 0;

            // Center horizontally if aligning to widest
            const x = alignToWidest ? (maxWidth - width) / 2 : 0;

            image.setWorldPosition(x, currentY, 0);

            result.images.push({
                id: image.id,
                x,
                y: currentY,
                width,
                height
            });

            result.totalWidth = Math.max(result.totalWidth, x + width);
            currentY += height + gap;
        }

        result.totalHeight = currentY - gap; // Remove last gap
        return result;
    }

    // Grid layout (rows and columns)
    private static layoutGrid(images: IIIFImage[], options: LayoutOptions): LayoutResult {
        const { gap, gridColumns } = options;
        const result: LayoutResult = { totalWidth: 0, totalHeight: 0, images: [] };

        if (images.length === 0) return result;

        // Calculate optimal number of columns if not specified
        const columns = gridColumns || Math.ceil(Math.sqrt(images.length));
        const rows = Math.ceil(images.length / columns);

        // Calculate max width per column and max height per row
        const columnWidths: number[] = new Array(columns).fill(0);
        const rowHeights: number[] = new Array(rows).fill(0);

        for (let i = 0; i < images.length; i++) {
            const col = i % columns;
            const row = Math.floor(i / columns);
            const image = images[i];

            columnWidths[col] = Math.max(columnWidths[col], image.width || 0);
            rowHeights[row] = Math.max(rowHeights[row], image.height || 0);
        }

        // Calculate starting positions for each column and row
        const columnStarts: number[] = [0];
        for (let c = 1; c < columns; c++) {
            columnStarts[c] = columnStarts[c - 1] + columnWidths[c - 1] + gap;
        }

        const rowStarts: number[] = [0];
        for (let r = 1; r < rows; r++) {
            rowStarts[r] = rowStarts[r - 1] + rowHeights[r - 1] + gap;
        }

        // Position each image centered in its cell
        for (let i = 0; i < images.length; i++) {
            const col = i % columns;
            const row = Math.floor(i / columns);
            const image = images[i];

            const width = image.width || 0;
            const height = image.height || 0;

            // Center within cell
            const x = columnStarts[col] + (columnWidths[col] - width) / 2;
            const y = rowStarts[row] + (rowHeights[row] - height) / 2;

            image.setWorldPosition(x, y, 0);

            result.images.push({
                id: image.id,
                x,
                y,
                width,
                height
            });
        }

        // Calculate total dimensions
        result.totalWidth = columnStarts[columns - 1] + columnWidths[columns - 1];
        result.totalHeight = rowStarts[rows - 1] + rowHeights[rows - 1];

        return result;
    }

    // Book layout (pairs of facing pages)
    private static layoutBook(images: IIIFImage[], options: LayoutOptions): LayoutResult {
        const { gap } = options;
        const result: LayoutResult = { totalWidth: 0, totalHeight: 0, images: [] };

        if (images.length === 0) return result;

        // Calculate spread dimensions (pairs of pages)
        const spreads: Array<{ left?: IIIFImage; right?: IIIFImage; width: number; height: number }> = [];

        for (let i = 0; i < images.length; i += 2) {
            const left = images[i];
            const right = images[i + 1];

            const leftWidth = left?.width || 0;
            const leftHeight = left?.height || 0;
            const rightWidth = right?.width || 0;
            const rightHeight = right?.height || 0;

            spreads.push({
                left,
                right,
                width: leftWidth + rightWidth + gap,
                height: Math.max(leftHeight, rightHeight)
            });
        }

        // Position spreads vertically
        let currentY = 0;
        let maxWidth = 0;

        for (const spread of spreads) {
            const spreadHeight = spread.height;
            let currentX = 0;

            if (spread.left) {
                const height = spread.left.height || 0;
                const y = currentY + (spreadHeight - height) / 2; // Center vertically

                spread.left.setWorldPosition(currentX, y, 0);

                result.images.push({
                    id: spread.left.id,
                    x: currentX,
                    y,
                    width: spread.left.width || 0,
                    height
                });

                currentX += (spread.left.width || 0) + gap;
            }

            if (spread.right) {
                const height = spread.right.height || 0;
                const y = currentY + (spreadHeight - height) / 2; // Center vertically

                spread.right.setWorldPosition(currentX, y, 0);

                result.images.push({
                    id: spread.right.id,
                    x: currentX,
                    y,
                    width: spread.right.width || 0,
                    height
                });

                currentX += (spread.right.width || 0);
            }

            maxWidth = Math.max(maxWidth, currentX);
            currentY += spreadHeight + gap * 2; // Extra gap between spreads
        }

        result.totalWidth = maxWidth;
        result.totalHeight = currentY - gap * 2; // Remove last gap

        return result;
    }

    // Get the bounding box of all positioned images
    static getBounds(images: IIIFImage[]): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
        if (images.length === 0) {
            return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const image of images) {
            const bounds = image.worldBounds;
            minX = Math.min(minX, bounds.left);
            minY = Math.min(minY, bounds.top);
            maxX = Math.max(maxX, bounds.right);
            maxY = Math.max(maxY, bounds.bottom);
        }

        return {
            minX,
            minY,
            maxX,
            maxY,
            width: maxX - minX,
            height: maxY - minY
        };
    }

    // Find images that intersect with a given viewport rectangle (world coordinates)
    static getVisibleImages(
        images: IIIFImage[],
        viewportLeft: number,
        viewportTop: number,
        viewportRight: number,
        viewportBottom: number
    ): IIIFImage[] {
        return images.filter(image => {
            const bounds = image.worldBounds;
            // Check for intersection
            return !(bounds.right < viewportLeft ||
                     bounds.left > viewportRight ||
                     bounds.bottom < viewportTop ||
                     bounds.top > viewportBottom);
        });
    }
}
