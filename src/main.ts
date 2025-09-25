import './style.scss'
import { IIIFViewer } from './IIIF/iiif';

const container = document.getElementById('iiif-container');
if (container) {
    const viewer = new IIIFViewer(container);
    viewer.addControls();
    viewer.listen('test');
    viewer.addImage('test','https://free.iiifhosting.com/iiif/f05a0fafa249ef246f0cfc4a747372c6963dfba48fa231a6e888b590c5638397/info.json')
        .then(() => {
            //console.log(viewer.returnManifest());
        })
        .catch((error) => {
            //console.error('Error loading manifest:', error);
        });
    } else {
    console.error('Container element not found');
}