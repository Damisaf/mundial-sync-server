# Servidor de Sincronización - Mundial 2026

Este servidor sincroniza automáticamente los resultados de partidos desde TheSportsDB a Firebase.

## Instalación

1. Clona este repositorio
2. Instala dependencias: `npm install`
3. Descarga tu JSON de credenciales de Firebase
4. Renómbralo a `firebase-key.json` y colócalo en la raíz
5. Ejecuta: `npm start`

## Credenciales Firebase

Para obtener tu `firebase-key.json`:

1. Ve a Firebase Console
2. Proyecto → Configuración (rueda) → Cuentas de servicio
3. Haz click en "Generar nueva clave privada"
4. Se descargará un JSON
5. Renómbralo a `firebase-key.json` y colócalo en la raíz del proyecto

## Desplegar en Render

1. Sube este repositorio a GitHub
2. Ve a Render.com y conecta tu GitHub
3. Crear nuevo "Web Service"
4. Selecciona este repositorio
5. Runtime: Node
6. Build command: `npm install`
7. Start command: `npm start`
8. Deploy

El servidor sincronizará automáticamente cada 5 minutos.

## Variables de entorno (opcional)

Si quieres cambiar el intervalo de sincronización, puedes agregar:
- `SYNC_INTERVAL`: Milisegundos entre sincronizaciones (default: 300000 = 5 min)
