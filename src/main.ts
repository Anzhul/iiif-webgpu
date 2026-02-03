import './style.scss'
import { IIIFViewer } from './IIIF/iiif';
import { parseIIIFUrl, type ParsedResource, type ParsedImageService, type ParsedManifest } from './IIIF/iiif-parser';

const container = document.getElementById('iiif-container');
if (container) {
    const viewer = new IIIFViewer(container, {
        toolbar: {
            zoom: true,
            annotations: true,
            //layers: true,
            CVButton: true,
            fullscreen: true
        },
        enableOverlays: true  // Enable overlay system
    });

    // Expose viewer globally for debugging/testing
    (window as any).viewer = viewer;

    viewer.listen();
    viewer.addImage('test','https://free.iiifhosting.com/iiif/616bc3c8dc9a69d3e935139c8c77b76f32137cab7ce0e4fd2166507cdc948b/info.json', true)
        .then(() => {
            console.log('Image loaded successfully');
            console.log('Viewer exposed on window.viewer - try: viewer.zoomByFactor(2, 1000)');
            viewer.startRenderLoop();

            // Demo: Add some example overlays and annotations after a short delay
            setTimeout(() => {
                addDemoOverlays(viewer);
                addDemoAnnotations(viewer);
            }, 500);
        })
        .catch((error) => {
            console.error('Error loading or rendering:', error);
        });
} else {
    console.error('Container element not found');
}

// Demo function to show overlay system in action
function addDemoOverlays(viewer: IIIFViewer) {
    if (!viewer.overlayManager) {
        console.log('Overlay manager not available');
        return;
    }

    // Get the world image to read its dimensions (world units = image dimensions)
    const worldImage = viewer.world.worldImages.get('test');
    if (!worldImage) return;

    const w = worldImage.placement.worldWidth;
    const h = worldImage.placement.worldHeight;

    console.log('Adding demo overlays...');
    console.log(`World dimensions: ${w}x${h}`);

    // Add a highlight box in the center
    const box = document.createElement('div');
    box.style.backgroundColor = 'rgba(255, 0, 0, 0.3)';
    box.style.border = '3px solid red';
    box.style.boxSizing = 'border-box';

    viewer.overlayManager.addOverlay({
        id: 'demo-box',
        element: box,
        worldX: w * 0.3,
        worldY: h * 0.3,
        worldWidth: w * 0.4,
        worldHeight: h * 0.4,
        scaleWithZoom: true
    });

    // Add a label
    const label = document.createElement('div');
    label.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
    label.style.color = 'white';
    label.style.padding = '12px 16px';
    label.style.borderRadius = '6px';
    label.style.fontSize = '16px';
    label.style.fontFamily = 'Arial, sans-serif';
    label.style.fontWeight = 'bold';
    label.textContent = 'Demo Overlay - Pan and Zoom!';

    viewer.overlayManager.addOverlay({
        id: 'demo-label',
        element: label,
        worldX: w * 0.1,
        worldY: h * 0.1,
        worldWidth: w * 0.15,
        worldHeight: h * 0.05,
        scaleWithZoom: true
    });

    // Add a fixed-size marker
    const marker = document.createElement('div');
    marker.style.width = '30px';
    marker.style.height = '30px';
    marker.style.backgroundColor = '#00ff00';
    marker.style.borderRadius = '50%';
    marker.style.border = '3px solid white';
    marker.style.boxShadow = '0 2px 8px rgba(0,0,0,0.5)';

    viewer.overlayManager.addOverlay({
        id: 'demo-marker',
        element: marker,
        worldX: w * 0.7,
        worldY: h * 0.2,
        worldWidth: 30,
        worldHeight: 30,
        scaleWithZoom: false  // This marker stays the same size
    });

    console.log('Demo overlays added! Try panning and zooming to see them move.');
    console.log('To remove overlays: viewer.overlayManager.clearAllOverlays()');
}

// Demo function to show annotation system in action
function addDemoAnnotations(viewer: IIIFViewer) {
    const worldImage = viewer.world.worldImages.get('test');
    if (!worldImage) return;

    const w = worldImage.placement.worldWidth;
    const h = worldImage.placement.worldHeight;

    console.log('Adding demo annotations...');

    // Add a simple annotation with text
    viewer.addAnnotation({
        id: 'annotation-1',
        fixed: true,
        x: w * 0.5,
        y: h * 0.5,
        width: w * 0.2,
        height: h * 0.15,
        style: {
            border: '3px solid #ff6b6b',
            backgroundColor: 'rgba(255, 107, 107, 0.2)',
            borderRadius: '8px'
        },
        content: {
            text: 'Annotation with Text'
        },
        scaleWithZoom: true
    });

    // Add another annotation
    viewer.addAnnotation({
        id: 'annotation-2',
        fixed: true,
        x: w * 0.15,
        y: h * 0.6,
        width: w * 0.18,
        height: h * 0.12,
        style: {
            border: '2px solid #4ecdc4',
            backgroundColor: 'rgba(78, 205, 196, 0.15)',
            borderRadius: '4px'
        },
        content: {
            text: 'Another Annotation'
        },
        scaleWithZoom: true
    });

    // Add annotation with custom HTML element
    const customElement = document.createElement('div');
    customElement.innerHTML = `
        <div style="text-align: center; color: white;">
            <h4 style="margin: 0 0 8px 0; font-size: 18px;">Custom Content</h4>
            <p style="margin: 0; font-size: 12px;">This annotation has custom HTML!</p>
        </div>
    `;

    viewer.addAnnotation({
        id: 'annotation-3',
        fixed: true,
        x: w * 0.65,
        y: h * 0.65,
        width: w * 0.25,
        height: h * 0.18,
        style: {
            border: '3px solid #9b59b6',
            backgroundColor: 'rgba(155, 89, 182, 0.3)',
            borderRadius: '12px'
        },
        content: {
            element: customElement
        },
        scaleWithZoom: true
    });

    console.log('Demo annotations added!');
    console.log('  - Try: viewer.annotationManager.clearAllAnnotations()');
}

// --- IIIF URL Test Panel ---
function setupTestPanel() {
    const input = document.getElementById('iiif-url-input') as HTMLInputElement;
    const submitBtn = document.getElementById('iiif-url-submit') as HTMLButtonElement;
    const resultDiv = document.getElementById('iiif-result') as HTMLElement;
    const toggleBtn = document.getElementById('test-panel-toggle') as HTMLButtonElement;
    const body = document.getElementById('test-panel-body') as HTMLElement;

    if (!input || !submitBtn || !resultDiv || !toggleBtn || !body) return;

    // Collapse/expand
    toggleBtn.addEventListener('click', () => {
        body.classList.toggle('collapsed');
        toggleBtn.textContent = body.classList.contains('collapsed') ? '+' : '−';
    });

    // Submit on button click or Enter
    const doSubmit = () => {
        const url = input.value.trim();
        if (!url) return;
        runParse(url, submitBtn, resultDiv);
    };

    submitBtn.addEventListener('click', doSubmit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSubmit();
    });
}

async function runParse(url: string, btn: HTMLButtonElement, resultDiv: HTMLElement) {
    btn.disabled = true;
    btn.textContent = 'Parsing...';
    resultDiv.innerHTML = '';

    try {
        const result = await parseIIIFUrl(url);
        resultDiv.innerHTML = renderResult(result);
        setupRawToggles(resultDiv);
    } catch (err: any) {
        resultDiv.innerHTML = `
            <span class="result-type error">Error</span>
            <div class="result-section">
                <div class="result-field">
                    <span class="label">Message</span>
                    <span class="value">${escapeHtml(err.message || String(err))}</span>
                </div>
            </div>
        `;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Parse';
    }
}

function renderResult(result: ParsedResource): string {
    if (result.type === 'image-service-2' || result.type === 'image-service-3') {
        return renderImageService(result as ParsedImageService);
    } else {
        return renderManifest(result as ParsedManifest);
    }
}

function renderImageService(svc: ParsedImageService): string {
    const sizesHtml = svc.sizes
        ? svc.sizes.map(s => `${s.width}×${s.height}`).join(', ')
        : 'none';

    return `
        <span class="result-type image-service">${svc.type}</span>
        <div class="result-section">
            <h4>Image Service</h4>
            <div class="result-field"><span class="label">ID</span><span class="value">${escapeHtml(svc.id)}</span></div>
            <div class="result-field"><span class="label">Dimensions</span><span class="value">${svc.width} × ${svc.height}</span></div>
            <div class="result-field"><span class="label">Tile Size</span><span class="value">${svc.tileWidth} × ${svc.tileHeight}</span></div>
            <div class="result-field"><span class="label">Scale Factors</span><span class="value">[${svc.scaleFactors.join(', ')}]</span></div>
            <div class="result-field"><span class="label">Sizes</span><span class="value">${sizesHtml}</span></div>
            ${svc.profile ? `<div class="result-field"><span class="label">Profile</span><span class="value">${escapeHtml(svc.profile)}</span></div>` : ''}
        </div>
        <button class="result-raw-toggle" data-target="raw-json">Show Raw JSON</button>
        <div class="result-raw" id="raw-json" style="display:none">${escapeHtml(JSON.stringify(svc.raw, null, 2))}</div>
    `;
}

function renderManifest(manifest: ParsedManifest): string {
    const canvasesHtml = manifest.canvases.map((c, i) => `
        <div class="result-canvas">
            <div class="result-field"><span class="label">Canvas ${i + 1}</span><span class="value">${escapeHtml(c.label || c.id)}</span></div>
            <div class="result-field"><span class="label">Dimensions</span><span class="value">${c.width} × ${c.height}</span></div>
            ${c.images.map((img, j) => `
                <div class="result-field"><span class="label">Image ${j + 1}</span><span class="value">${escapeHtml(img.imageServiceUrl)}</span></div>
                <div class="result-field"><span class="label">  Size</span><span class="value">${img.width} × ${img.height}</span></div>
                ${img.target ? `<div class="result-field"><span class="label">  Target</span><span class="value">xywh=${img.target.x},${img.target.y},${img.target.w},${img.target.h}</span></div>` : ''}
            `).join('')}
        </div>
    `).join('');

    return `
        <span class="result-type manifest">${manifest.type}</span>
        <div class="result-section">
            <h4>Manifest</h4>
            <div class="result-field"><span class="label">ID</span><span class="value">${escapeHtml(manifest.id)}</span></div>
            ${manifest.label ? `<div class="result-field"><span class="label">Label</span><span class="value">${escapeHtml(manifest.label)}</span></div>` : ''}
            <div class="result-field"><span class="label">Canvases</span><span class="value">${manifest.canvases.length}</span></div>
        </div>
        <div class="result-section">
            <h4>Canvases</h4>
            ${canvasesHtml}
        </div>
        <button class="result-raw-toggle" data-target="raw-json">Show Raw JSON</button>
        <div class="result-raw" id="raw-json" style="display:none">${escapeHtml(JSON.stringify(manifest.raw, null, 2))}</div>
    `;
}

function setupRawToggles(container: HTMLElement) {
    container.querySelectorAll('.result-raw-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = (btn as HTMLElement).dataset.target;
            if (!targetId) return;
            const raw = container.querySelector(`#${targetId}`) as HTMLElement;
            if (!raw) return;
            const visible = raw.style.display !== 'none';
            raw.style.display = visible ? 'none' : 'block';
            btn.textContent = visible ? 'Show Raw JSON' : 'Hide Raw JSON';
        });
    });
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

setupTestPanel();
