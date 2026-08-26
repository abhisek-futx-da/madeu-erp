import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PortalApp } from './portal/PortalApp'
import './index.css'

// A hash rather than a path: the portal then works behind any static server —
// nginx, a bare Vite preview, a file opened from a USB stick — with no rewrite
// rule to configure at a dyeing house that has no IT department.
const isPortal = window.location.hash.replace(/^#\/?/, '') === 'portal'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isPortal ? <PortalApp /> : <App />}
  </React.StrictMode>,
)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(error => {
      console.error('offline shell registration failed', error)
    })
  })
}
