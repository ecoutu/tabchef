// The side panel (M3 T17): an unlisted page (`panel.html`, not `sidepanel`, so WXT adds no `side_panel` manifest key or
// required `sidePanel` permission), enabled at runtime by the popup with sidePanel.setOptions.
import { mount } from 'svelte';
import '../../ui/tokens.css';
import App from './App.svelte';

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
