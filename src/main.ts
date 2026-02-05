import './style.scss'
import { IIIFViewer } from './IIIF/iiif';
import { parseIIIFUrl, fetchAnnotationList, type ParsedResource, type ParsedImageService, type ParsedManifest } from './IIIF/iiif-parser';

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
    viewer.startRenderLoop();
    setupTestPanel(viewer);

    viewer.loadUrl('https://iiif.harvardartmuseums.org/manifests/object/299843')
        .then(() => {
            console.log('Image loaded via loadUrl()');
            console.log('Try: viewer.loadUrl("https://iiif.harvardartmuseums.org/manifests/object/299843")');
            console.log('Then: viewer.nextCanvas(), viewer.previousCanvas()');
        })
        .catch((error) => {
            console.error('Error loading:', error);
        });
} else {
    console.error('Container element not found');
}

// --- IIIF URL Test Panel ---
function setupTestPanel(viewer: IIIFViewer) {
    const input = document.getElementById('iiif-url-input') as HTMLInputElement;
    const submitBtn = document.getElementById('iiif-url-submit') as HTMLButtonElement;
    const loadBtn = document.getElementById('iiif-url-load') as HTMLButtonElement;
    const resultDiv = document.getElementById('iiif-result') as HTMLElement;
    const toggleBtn = document.getElementById('test-panel-toggle') as HTMLButtonElement;
    const body = document.getElementById('test-panel-body') as HTMLElement;

    if (!input || !submitBtn || !loadBtn || !resultDiv || !toggleBtn || !body) return;

    // Collapse/expand
    toggleBtn.addEventListener('click', () => {
        body.classList.toggle('collapsed');
        toggleBtn.textContent = body.classList.contains('collapsed') ? '+' : '\u2212';
    });

    // Parse button
    submitBtn.addEventListener('click', () => {
        const url = input.value.trim();
        if (url) runParse(url, submitBtn, resultDiv);
    });

    // Load in viewer button
    loadBtn.addEventListener('click', () => {
        const url = input.value.trim();
        if (!url) return;
        loadBtn.disabled = true;
        loadBtn.textContent = 'Loading...';
        viewer.loadUrl(url)
            .then(() => {
                loadBtn.textContent = 'Loaded';
                if (viewer.canvasCount > 0) {
                    resultDiv.innerHTML = `
                        <span class="result-type manifest">Loaded</span>
                        <div class="result-section">
                            <div class="result-field"><span class="label">Canvas</span><span class="value">${viewer.currentCanvas + 1} / ${viewer.canvasCount}</span></div>
                        </div>
                    `;
                }
            })
            .catch((err: any) => {
                resultDiv.innerHTML = `
                    <span class="result-type error">Load Error</span>
                    <div class="result-section">
                        <div class="result-field"><span class="label">Message</span><span class="value">${escapeHtml(err.message || String(err))}</span></div>
                    </div>
                `;
            })
            .finally(() => {
                loadBtn.disabled = false;
                loadBtn.textContent = 'Load';
            });
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const url = input.value.trim();
            if (url) runParse(url, submitBtn, resultDiv);
        }
    });
}

async function runParse(url: string, btn: HTMLButtonElement, resultDiv: HTMLElement) {
    btn.disabled = true;
    btn.textContent = 'Parsing...';
    resultDiv.innerHTML = '';

    try {
        const result = await parseIIIFUrl(url);

        // Fetch external annotation lists for manifests
        if (result.type === 'manifest-2' || result.type === 'manifest-3') {
            const manifest = result as ParsedManifest;
            for (const canvas of manifest.canvases) {
                for (const listUrl of canvas.annotationListUrls) {
                    try {
                        const page = await fetchAnnotationList(listUrl);
                        if (page && page.annotations.length > 0) {
                            canvas.annotations.push(page);
                        }
                    } catch {
                        // Skip failed annotation list fetches
                    }
                }
            }
        }

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
        ? svc.sizes.map(s => `${s.width}\u00d7${s.height}`).join(', ')
        : 'none';

    return `
        <span class="result-type image-service">${svc.type}</span>
        <div class="result-section">
            <h4>Image Service</h4>
            <div class="result-field"><span class="label">ID</span><span class="value">${escapeHtml(svc.id)}</span></div>
            <div class="result-field"><span class="label">Dimensions</span><span class="value">${svc.width} \u00d7 ${svc.height}</span></div>
            <div class="result-field"><span class="label">Tile Size</span><span class="value">${svc.tileWidth} \u00d7 ${svc.tileHeight}</span></div>
            <div class="result-field"><span class="label">Scale Factors</span><span class="value">[${svc.scaleFactors.join(', ')}]</span></div>
            <div class="result-field"><span class="label">Sizes</span><span class="value">${sizesHtml}</span></div>
            ${svc.profile ? `<div class="result-field"><span class="label">Profile</span><span class="value">${escapeHtml(svc.profile)}</span></div>` : ''}
        </div>
        <button class="result-raw-toggle" data-target="raw-json">Show Raw JSON</button>
        <div class="result-raw" id="raw-json" style="display:none">${escapeHtml(JSON.stringify(svc.raw, null, 2))}</div>
    `;
}

function renderManifest(manifest: ParsedManifest): string {
    const totalAnnotations = manifest.canvases.reduce((sum, c) =>
        sum + c.annotations.reduce((s, p) => s + p.annotations.length, 0), 0);
    const totalAnnotationListUrls = manifest.canvases.reduce((sum, c) => sum + c.annotationListUrls.length, 0);

    const canvasesHtml = manifest.canvases.map((c, i) => {
        const canvasAnnotationCount = c.annotations.reduce((s, p) => s + p.annotations.length, 0);

        const annotationsHtml = c.annotations.flatMap(page =>
            page.annotations.map(ann => {
                const bodyPreview = ann.body.value
                    ? escapeHtml(ann.body.value.replace(/<[^>]*>/g, '').substring(0, 120))
                    : (ann.body.id ? escapeHtml(ann.body.id) : 'no body');
                return `
                    <div class="result-field"><span class="label">  ${escapeHtml(ann.motivation)}</span><span class="value">${bodyPreview}</span></div>
                    ${ann.target ? `<div class="result-field"><span class="label">    target</span><span class="value">xywh=${ann.target.x},${ann.target.y},${ann.target.w},${ann.target.h}</span></div>` : ''}
                `;
            })
        ).join('');

        return `
            <div class="result-canvas">
                <div class="result-field"><span class="label">Canvas ${i + 1}</span><span class="value">${escapeHtml(c.label || c.id)}</span></div>
                <div class="result-field"><span class="label">Dimensions</span><span class="value">${c.width} \u00d7 ${c.height}</span></div>
                ${c.images.map((img, j) => `
                    <div class="result-field"><span class="label">Image ${j + 1}</span><span class="value">${escapeHtml(img.imageServiceUrl)}</span></div>
                    <div class="result-field"><span class="label">  Size</span><span class="value">${img.width} \u00d7 ${img.height}</span></div>
                    ${img.target ? `<div class="result-field"><span class="label">  Target</span><span class="value">xywh=${img.target.x},${img.target.y},${img.target.w},${img.target.h}</span></div>` : ''}
                `).join('')}
                ${canvasAnnotationCount > 0 ? `
                    <div class="result-field"><span class="label">Annotations</span><span class="value">${canvasAnnotationCount}</span></div>
                    ${annotationsHtml}
                ` : ''}
                ${c.annotationListUrls.length > 0 && canvasAnnotationCount === 0 ? `
                    <div class="result-field"><span class="label">Annotation Lists</span><span class="value">${c.annotationListUrls.length} (external)</span></div>
                ` : ''}
            </div>
        `;
    }).join('');

    return `
        <span class="result-type manifest">${manifest.type}</span>
        <div class="result-section">
            <h4>Manifest</h4>
            <div class="result-field"><span class="label">ID</span><span class="value">${escapeHtml(manifest.id)}</span></div>
            ${manifest.label ? `<div class="result-field"><span class="label">Label</span><span class="value">${escapeHtml(manifest.label)}</span></div>` : ''}
            <div class="result-field"><span class="label">Canvases</span><span class="value">${manifest.canvases.length}</span></div>
            ${totalAnnotations > 0 ? `<div class="result-field"><span class="label">Annotations</span><span class="value">${totalAnnotations} total</span></div>` : ''}
            ${totalAnnotationListUrls > 0 && totalAnnotations === 0 ? `<div class="result-field"><span class="label">Annotation Lists</span><span class="value">${totalAnnotationListUrls} (external)</span></div>` : ''}
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
