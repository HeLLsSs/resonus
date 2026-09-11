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
