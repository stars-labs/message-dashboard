import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

// Only mount in the browser
let app: ReturnType<typeof mount> | undefined;
if (typeof window !== 'undefined') {
  const target = document.getElementById('app');
  if (target === null) throw new Error('index.html has no #app element to mount into');
  app = mount(App, { target });
}

export default app;
