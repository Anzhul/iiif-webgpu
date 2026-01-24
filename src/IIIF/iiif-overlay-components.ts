/**
 * Factory functions for creating common overlay components
 */

// ============================================
// BASIC COMPONENTS
// ============================================

/**
 * Create a simple text label
 */
export function createLabel(text: string, options?: {
    color?: string;
    background?: string;
    fontSize?: string;
    padding?: string;
    borderRadius?: string;
}): HTMLElement {
    const label = document.createElement('div');
    label.textContent = text;
    label.style.cssText = `
        color: ${options?.color || 'white'};
        background: ${options?.background || 'rgba(0, 0, 0, 0.8)'};
        font-size: ${options?.fontSize || '14px'};
        padding: ${options?.padding || '8px 12px'};
        border-radius: ${options?.borderRadius || '4px'};
        font-family: Arial, sans-serif;
        white-space: nowrap;
    `;
    return label;
}

/**
 * Create a circular marker/pin
 */
export function createMarker(options?: {
    color?: string;
    borderColor?: string;
    size?: number;
    label?: string;
}): HTMLElement {
    const size = options?.size || 24;
    const marker = document.createElement('div');
    marker.style.cssText = `
        width: ${size}px;
        height: ${size}px;
        background: ${options?.color || '#ff4444'};
        border: 3px solid ${options?.borderColor || 'white'};
        border-radius: 50%;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: ${size * 0.5}px;
        font-weight: bold;
        color: white;
        font-family: Arial, sans-serif;
    `;
    if (options?.label) {
        marker.textContent = options.label;
    }
    return marker;
}

/**
 * Create a highlight box (transparent with border)
 */
export function createHighlight(options?: {
    borderColor?: string;
    borderWidth?: string;
    backgroundColor?: string;
    borderRadius?: string;
    borderStyle?: string;
}): HTMLElement {
    const box = document.createElement('div');
    box.style.cssText = `
        border: ${options?.borderWidth || '3px'} ${options?.borderStyle || 'solid'} ${options?.borderColor || '#ffcc00'};
        background: ${options?.backgroundColor || 'rgba(255, 204, 0, 0.15)'};
        border-radius: ${options?.borderRadius || '0'};
        box-sizing: border-box;
        width: 100%;
        height: 100%;
    `;
    return box;
}

// ============================================
// COMPOSITE COMPONENTS
// ============================================

/**
 * Create an info card with title and description
 */
export function createInfoCard(options: {
    title: string;
    description?: string;
    headerColor?: string;
    headerBackground?: string;
}): HTMLElement {
    const card = document.createElement('div');
    card.style.cssText = `
        background: white;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        overflow: hidden;
        font-family: Arial, sans-serif;
    `;

    const header = document.createElement('div');
    header.textContent = options.title;
    header.style.cssText = `
        padding: 12px 16px;
        font-weight: bold;
        font-size: 14px;
        background: ${options.headerBackground || '#2196F3'};
        color: ${options.headerColor || 'white'};
    `;
    card.appendChild(header);

    if (options.description) {
        const body = document.createElement('div');
        body.textContent = options.description;
        body.style.cssText = `
            padding: 12px 16px;
            font-size: 13px;
            color: #333;
            line-height: 1.4;
        `;
        card.appendChild(body);
    }

    return card;
}

/**
 * Create a tooltip with key-value pairs
 */
export function createTooltip(options: {
    title?: string;
    items: { label: string; value: string }[];
    background?: string;
    color?: string;
}): HTMLElement {
    const tooltip = document.createElement('div');
    tooltip.style.cssText = `
        background: ${options.background || 'rgba(0, 0, 0, 0.9)'};
        color: ${options.color || 'white'};
        border-radius: 8px;
        padding: 12px;
        font-family: Arial, sans-serif;
        font-size: 12px;
        min-width: 150px;
    `;

    if (options.title) {
        const title = document.createElement('div');
        title.textContent = options.title;
        title.style.cssText = `
            font-weight: bold;
            font-size: 13px;
            margin-bottom: 8px;
            padding-bottom: 8px;
            border-bottom: 1px solid rgba(255,255,255,0.2);
        `;
        tooltip.appendChild(title);
    }

    options.items.forEach(item => {
        const row = document.createElement('div');
        row.style.cssText = `
            display: flex;
            justify-content: space-between;
            margin: 4px 0;
        `;
        row.innerHTML = `
            <span style="opacity: 0.7;">${item.label}</span>
            <span style="font-weight: 500;">${item.value}</span>
        `;
        tooltip.appendChild(row);
    });

    return tooltip;
}

/**
 * Create a numbered marker with optional label
 */
export function createNumberedMarker(options: {
    number: number;
    label?: string;
    color?: string;
}): HTMLElement {
    const container = document.createElement('div');
    container.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
    `;

    const circle = document.createElement('div');
    circle.textContent = String(options.number);
    circle.style.cssText = `
        width: 28px;
        height: 28px;
        background: ${options.color || '#e74c3c'};
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-weight: bold;
        font-size: 14px;
        font-family: Arial, sans-serif;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        border: 2px solid white;
    `;
    container.appendChild(circle);

    if (options.label) {
        const label = document.createElement('div');
        label.textContent = options.label;
        label.style.cssText = `
            background: white;
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            font-family: Arial, sans-serif;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            white-space: nowrap;
        `;
        container.appendChild(label);
    }

    return container;
}

/**
 * Create a callout with arrow pointing to a location
 */
export function createCallout(options: {
    text: string;
    background?: string;
    color?: string;
    arrowPosition?: 'left' | 'right' | 'top' | 'bottom';
}): HTMLElement {
    const container = document.createElement('div');
    container.style.cssText = `
        position: relative;
        font-family: Arial, sans-serif;
    `;

    const bubble = document.createElement('div');
    bubble.textContent = options.text;
    bubble.style.cssText = `
        background: ${options.background || 'white'};
        color: ${options.color || '#333'};
        padding: 10px 14px;
        border-radius: 6px;
        font-size: 13px;
        box-shadow: 0 3px 12px rgba(0,0,0,0.15);
        white-space: nowrap;
    `;
    container.appendChild(bubble);

    // Add arrow
    const arrow = document.createElement('div');
    const arrowPos = options.arrowPosition || 'bottom';
    const bg = options.background || 'white';

    if (arrowPos === 'bottom') {
        arrow.style.cssText = `
            position: absolute;
            bottom: -8px;
            left: 50%;
            transform: translateX(-50%);
            width: 0;
            height: 0;
            border-left: 8px solid transparent;
            border-right: 8px solid transparent;
            border-top: 8px solid ${bg};
        `;
    } else if (arrowPos === 'top') {
        arrow.style.cssText = `
            position: absolute;
            top: -8px;
            left: 50%;
            transform: translateX(-50%);
            width: 0;
            height: 0;
            border-left: 8px solid transparent;
            border-right: 8px solid transparent;
            border-bottom: 8px solid ${bg};
        `;
    } else if (arrowPos === 'left') {
        arrow.style.cssText = `
            position: absolute;
            left: -8px;
            top: 50%;
            transform: translateY(-50%);
            width: 0;
            height: 0;
            border-top: 8px solid transparent;
            border-bottom: 8px solid transparent;
            border-right: 8px solid ${bg};
        `;
    } else if (arrowPos === 'right') {
        arrow.style.cssText = `
            position: absolute;
            right: -8px;
            top: 50%;
            transform: translateY(-50%);
            width: 0;
            height: 0;
            border-top: 8px solid transparent;
            border-bottom: 8px solid transparent;
            border-left: 8px solid ${bg};
        `;
    }
    container.appendChild(arrow);

    return container;
}

/**
 * Create a badge/tag
 */
export function createBadge(text: string, options?: {
    color?: string;
    background?: string;
    size?: 'small' | 'medium' | 'large';
}): HTMLElement {
    const sizes = {
        small: { fontSize: '10px', padding: '2px 6px' },
        medium: { fontSize: '12px', padding: '4px 10px' },
        large: { fontSize: '14px', padding: '6px 14px' }
    };
    const size = sizes[options?.size || 'medium'];

    const badge = document.createElement('span');
    badge.textContent = text;
    badge.style.cssText = `
        display: inline-block;
        background: ${options?.background || '#e74c3c'};
        color: ${options?.color || 'white'};
        font-size: ${size.fontSize};
        padding: ${size.padding};
        border-radius: 12px;
        font-family: Arial, sans-serif;
        font-weight: 500;
        white-space: nowrap;
    `;
    return badge;
}

/**
 * Create an icon button
 */
export function createIconButton(options: {
    icon: string; // Unicode or emoji
    onClick?: () => void;
    size?: number;
    color?: string;
    background?: string;
}): HTMLElement {
    const size = options.size || 32;
    const button = document.createElement('button');
    button.textContent = options.icon;
    button.style.cssText = `
        width: ${size}px;
        height: ${size}px;
        border: none;
        border-radius: 50%;
        background: ${options.background || 'white'};
        color: ${options.color || '#333'};
        font-size: ${size * 0.5}px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        transition: transform 0.1s, box-shadow 0.1s;
    `;

    button.addEventListener('mouseenter', () => {
        button.style.transform = 'scale(1.1)';
        button.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
    });
    button.addEventListener('mouseleave', () => {
        button.style.transform = 'scale(1)';
        button.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
    });

    if (options.onClick) {
        button.addEventListener('click', options.onClick);
    }

    return button;
}

/**
 * Create a panel with header, body, and optional footer
 */
export function createPanel(options: {
    title: string;
    body: string | HTMLElement;
    footer?: string | HTMLElement;
    width?: string;
    headerBackground?: string;
}): HTMLElement {
    const panel = document.createElement('div');
    panel.style.cssText = `
        background: white;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        overflow: hidden;
        font-family: Arial, sans-serif;
        width: ${options.width || 'auto'};
    `;

    // Header
    const header = document.createElement('div');
    header.textContent = options.title;
    header.style.cssText = `
        padding: 14px 16px;
        font-weight: 600;
        font-size: 15px;
        background: ${options.headerBackground || '#1a73e8'};
        color: white;
    `;
    panel.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.style.cssText = `
        padding: 16px;
        font-size: 14px;
        color: #333;
        line-height: 1.5;
    `;
    if (typeof options.body === 'string') {
        body.textContent = options.body;
    } else {
        body.appendChild(options.body);
    }
    panel.appendChild(body);

    // Footer
    if (options.footer) {
        const footer = document.createElement('div');
        footer.style.cssText = `
            padding: 12px 16px;
            background: #f5f5f5;
            border-top: 1px solid #eee;
            font-size: 13px;
            color: #666;
        `;
        if (typeof options.footer === 'string') {
            footer.textContent = options.footer;
        } else {
            footer.appendChild(options.footer);
        }
        panel.appendChild(footer);
    }

    return panel;
}

/**
 * Create an image thumbnail with optional caption
 */
export function createThumbnail(options: {
    src: string;
    alt?: string;
    caption?: string;
    width?: string;
}): HTMLElement {
    const container = document.createElement('div');
    container.style.cssText = `
        background: white;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        overflow: hidden;
        width: ${options.width || 'auto'};
    `;

    const img = document.createElement('img');
    img.src = options.src;
    img.alt = options.alt || '';
    img.style.cssText = `
        width: 100%;
        display: block;
    `;
    container.appendChild(img);

    if (options.caption) {
        const caption = document.createElement('div');
        caption.textContent = options.caption;
        caption.style.cssText = `
            padding: 10px 12px;
            font-size: 12px;
            color: #666;
            font-family: Arial, sans-serif;
            text-align: center;
        `;
        container.appendChild(caption);
    }

    return container;
}

/**
 * Create a progress indicator
 */
export function createProgress(options: {
    value: number; // 0-100
    label?: string;
    color?: string;
    width?: string;
}): HTMLElement {
    const container = document.createElement('div');
    container.style.cssText = `
        background: white;
        border-radius: 8px;
        padding: 12px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        font-family: Arial, sans-serif;
        width: ${options.width || '150px'};
    `;

    if (options.label) {
        const label = document.createElement('div');
        label.textContent = options.label;
        label.style.cssText = `
            font-size: 12px;
            color: #666;
            margin-bottom: 8px;
        `;
        container.appendChild(label);
    }

    const track = document.createElement('div');
    track.style.cssText = `
        height: 8px;
        background: #e0e0e0;
        border-radius: 4px;
        overflow: hidden;
    `;

    const fill = document.createElement('div');
    fill.style.cssText = `
        height: 100%;
        width: ${Math.min(100, Math.max(0, options.value))}%;
        background: ${options.color || '#4caf50'};
        border-radius: 4px;
        transition: width 0.3s;
    `;
    track.appendChild(fill);
    container.appendChild(track);

    const valueText = document.createElement('div');
    valueText.textContent = `${Math.round(options.value)}%`;
    valueText.style.cssText = `
        font-size: 11px;
        color: #999;
        text-align: right;
        margin-top: 4px;
    `;
    container.appendChild(valueText);

    return container;
}
