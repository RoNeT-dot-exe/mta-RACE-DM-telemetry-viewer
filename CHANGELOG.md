# Changelog

## v1.0.1 - 2026-10-27

- `meta.title`: el servidor guarda el nombre del mapa y el visor lo muestra en el HUD.
- Si la telemetria no trae mapa, el visor usa el nombre del `.map` cargado.
- El servidor recuerda el ultimo mapa si `getRunningGamemodeMap()` falla.
- Warps de sesion: se limpian al reiniciar la sesion y al cambiar de mapa.
- Correcciones de warps (reanudacion, lista, limite, modelo, archivo anidado).

## v1.0.0 - 2026-10-27

- Primera version publica.
- Telemetria 20 Hz (client.lua + server.lua), JSONL, carpeta por mapa.
- Warps: guardar / cargar / eliminar, marca de warp, persistencia por jugador.
- Auditoria de warps: 5 fixes (ver README).
- Viewer estatico: HUD, tacómetro, linea de tiempo, busqueda por pieza y tiempo, ajustes.
