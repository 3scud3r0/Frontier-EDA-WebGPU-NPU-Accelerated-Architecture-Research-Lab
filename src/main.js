import './styles.css';
import { bootstrapResearchLab } from './app.js';

bootstrapResearchLab().then(lab => {
  globalThis.frontierLab = lab;
}).catch(error => {
  console.error(error);
  const status = document.getElementById('status-line');
  if (status) {
    status.textContent = `BOOT FAILURE: ${error.message}`;
    status.dataset.kind = 'error';
  }
});
