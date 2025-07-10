import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// Only mount in the browser
let app
if (typeof window !== 'undefined') {
  app = mount(App, {
    target: document.getElementById('app'),
  })
}

export default app
