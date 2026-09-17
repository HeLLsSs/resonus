// Punto de entrada de la app. El audio lo gestiona expo-audio (ver
// src/store/player.ts) y la sesión del coche el módulo modules/car-auto.
import { startApp } from '@/lib/bootstrap';
import 'expo-router/entry';

// Outside React, as the runtime starts. The router only registers a component
// here; nothing of it is mounted until an Activity asks for a screen, and the
// car, the widget and another app's broadcast can start this runtime with no
// Activity behind them. What they asked for has to find a session, settings
// and a queue waiting for it, so none of that can live in an effect.
startApp();

// In a browser, the service worker (public/sw.js) is what keeps the app and
// what it played within reach when the network is not: registered once the
// page is up, never on a phone, where the app has a file system of its own.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
  });
}
