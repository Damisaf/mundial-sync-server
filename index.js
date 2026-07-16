const admin = require('firebase-admin');
const axios = require('axios');

let serviceAccount;
if (process.env.FIREBASE_KEY_BASE64) {
  const keyString = Buffer.from(process.env.FIREBASE_KEY_BASE64, 'base64').toString('utf8');
  serviceAccount = JSON.parse(keyString);
} else {
  serviceAccount = require('./firebase-key.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://mundial-2026-5aa8a.firebaseio.com'
});

const db = admin.firestore();
const SPORTSDB_KEY = '123';

const TOURNAMENTS = {
  mundial: { name: 'Mundial 2026', collection: 'matches', predPrefix: 'predictions_mundial', leagueId: 4429, season: 2026 },
  liga: { name: 'Liga Argentina', collection: 'matches_liga', predPrefix: 'predictions_liga', leagueId: 4406, season: 2026 }
};

async function fetchRoundData(leagueId, round, season) {
  try {
    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsround.php?id=${leagueId}&r=${round}&s=${season}`;
    const response = await axios.get(url);
    return response.data.events || [];
  } catch (error) {
    console.error(`Error fetching round ${round}:`, error.message);
    return [];
  }
}

// Cerrar predicciones de partidos terminados
async function closePredictions(tournamentKey, finishedMatchIds) {
  if (!finishedMatchIds.length) return;
  const tour = TOURNAMENTS[tournamentKey];

  try {
    // Buscar todas las colecciones de predicciones para este torneo
    const collections = await db.listCollections();
    const predCols = collections
      .map(c => c.id)
      .filter(id => id.startsWith('predictions_') && id.includes(tournamentKey === 'liga' ? 'liga' : 'mundial'));

    for (const colId of predCols) {
      for (const matchId of finishedMatchIds) {
        const snapshot = await db.collection(colId)
          .where('matchId', '==', matchId)
          .where('closed', '==', false)
          .get();

        // También buscar predicciones sin campo closed
        const snapshot2 = await db.collection(colId)
          .where('matchId', '==', matchId)
          .get();

        const batch = db.batch();
        let count = 0;
        snapshot2.forEach(doc => {
          const data = doc.data();
          if (!data.closed) {
            batch.update(doc.ref, { closed: true });
            count++;
          }
        });

        if (count > 0) {
          await batch.commit();
          console.log(`   🔒 ${count} predicciones cerradas en ${colId} para ${matchId}`);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error cerrando predicciones:', error.message);
  }
}

function translateStageServer(round) {
  const r = parseInt(round);
  if (r === 0 || r === 150) return 'Semifinales'; // TheSportsDB usa 0 o 150 para semifinales
  if (r === 125) return 'Cuartos de final';
  if (r === 160 || r === 200) return '3er puesto y Final'; // CONFIRMADO: 160=Tercer puesto, 200=Final del Mundial 2026
  if (r === 16) return 'Octavos de final';
  if (r === 32) return 'Dieciseisavos de final';
  if (r >= 160 && r <= 169) return '3er puesto y Final';
  if (r >= 170 && r <= 179) return 'Cuartos de final';
  if (r >= 180 && r <= 189) return 'Semifinales';
  if (r === 190 || r === 191) return '3er puesto y Final';
  return `Fecha ${r}`;
}

async function importNewMatches(tournamentKey, events) {
  const tour = TOURNAMENTS[tournamentKey];
  if (!events || !events.length) return;
  
  let imported = 0;
  const batch = db.batch();
  
  for (const e of events) {
    const matchId = `match_${e.idEvent}`;
    const docRef = db.collection(tour.collection).doc(matchId);
    const existing = await docRef.get();
    if (existing.exists) continue;
    
    const matchDate = new Date(e.strTimestamp || `${e.dateEvent}T${e.strTime || '00:00:00'}`);
    const stage = translateStageServer(e.intRound);
    
    batch.set(docRef, {
      fixtureId: e.idEvent,
      homeName: e.strHomeTeam,
      awayName: e.strAwayTeam,
      homeBadge: e.strHomeTeamBadge || '',
      awayBadge: e.strAwayTeamBadge || '',
      matchDate: matchDate,
      stage: stage,
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
      leagueId: tour.leagueId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    imported++;
  }
  
  if (imported > 0) {
    await batch.commit();
    console.log(`   ✅ ${imported} partidos nuevos importados`);
  }
}

async function syncTournament(tournamentKey) {
  const tour = TOURNAMENTS[tournamentKey];
  console.log(`\n📡 Sincronizando ${tour.name}...`);

  try {
    const now = new Date();
    
    // Importar partidos próximos que no estén en Firestore
    try {
      const nextRes = await axios.get(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsnextleague.php?id=${tour.leagueId}`);
      const nextEvents = nextRes.data.events || [];
      if (nextEvents.length > 0) {
        // Importar el próximo partido
        await importNewMatches(tournamentKey, nextEvents);
        // También traer todos los partidos de esa misma ronda
        const roundNum = nextEvents[0].intRound;
        if (roundNum) {
          const roundRes = await axios.get(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsround.php?id=${tour.leagueId}&r=${roundNum}&s=${tour.season}`);
          const roundEvents = roundRes.data.events || [];
          if (roundEvents.length > 0) {
            await importNewMatches(tournamentKey, roundEvents);
            console.log(`   📥 Ronda ${roundNum}: ${roundEvents.length} partidos verificados`);
          }
        }
      }
    } catch(e) {
      console.log(`   ⚠️  No se pudieron importar próximos partidos: ${e.message}`);
    }

    const desde = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const hasta = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

    const snapshot = await db.collection(tour.collection)
      .where('matchDate', '>=', desde)
      .where('matchDate', '<=', hasta)
      .get();

    const matches = {};
    snapshot.forEach(doc => { matches[doc.id] = doc.data(); });

    console.log(`   📊 Partidos en ventana de 4 días: ${Object.keys(matches).length}`);

    let closestMatch = null;
    let closestDiff = Infinity;
    Object.values(matches).forEach(m => {
      const d = m.matchDate?.toDate ? m.matchDate.toDate() : new Date(m.matchDate || 0);
      const diff = Math.abs(d - now);
      if (diff < closestDiff) { closestDiff = diff; closestMatch = m; }
    });

    // Determinar ronda: para stages eliminatorios buscar en la API directamente
    let roundNum = null;
    if (closestMatch?.stage) {
      const nums = closestMatch.stage.replace(/\D/g, '');
      if (nums) {
        roundNum = nums;
      } else {
        // Stage eliminatorio — buscar ronda en mapa inverso
        const stageToRound = {
          'Dieciseisavos de final': '32',
          'Octavos de final': '16',
          'Cuartos de final': '125', 'Semifinales': '150', '3er puesto y Final': '160', 'Tercer puesto': '160', 'Final': '200'
        };
        roundNum = stageToRound[closestMatch.stage] || null;
      }
    }
    if (!roundNum) { console.log(`   ⚠️  No se encontró ronda para sincronizar`); return; }

    console.log(`   📋 Sincronizando ronda ${roundNum}...`);
    const events = await fetchRoundData(tour.leagueId, roundNum, tour.season);
    console.log(`   ✅ ${events.length} eventos obtenidos`);

    let updatedCount = 0;
    const updates = {};
    const newlyFinished = [];

    events.forEach(e => {
      const homeScore = e.intHomeScore !== null && e.intHomeScore !== '' ? parseInt(e.intHomeScore) : null;
      const awayScore = e.intAwayScore !== null && e.intAwayScore !== '' ? parseInt(e.intAwayScore) : null;
      if (homeScore === null || awayScore === null) return;

      const matchId = `match_${e.idEvent}`;
      const cached = matches[matchId];
      if (!cached) return;

      const hasChanged = cached.homeScore !== homeScore || cached.awayScore !== awayScore ||
        cached.status !== (e.strStatus === 'Match Finished' ? 'finished' : 'live');

      if (hasChanged) {
        const matchDate = cached.matchDate?.toDate ? cached.matchDate.toDate() : new Date(cached.matchDate || 0);
        const hoursElapsed = (now - matchDate) / (1000 * 60 * 60);
        const isFinished = e.strStatus === 'Match Finished' || hoursElapsed >= 2;
        const result = isFinished ? (homeScore > awayScore ? '1' : homeScore === awayScore ? 'X' : '2') : undefined;

        const update = {
          homeScore, awayScore,
          status: isFinished ? 'finished' : 'live',
          fixtureId: e.idEvent,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (result !== undefined) update.result = result;
        updates[matchId] = update;

        // Si recién terminó, agregar a la lista para cerrar predicciones
        if (isFinished && cached.status !== 'finished') {
          newlyFinished.push(matchId);
        }
        updatedCount++;
      }
    });

    // Timeout 2.5hs para partidos en vivo — cubre 90' + descuento + alargue (30') + penales.
    // IMPORTANTE: si la API reporta explícitamente que está en alargue (ET) o penales (P),
    // NO forzar finished aunque hayan pasado 2hs — dejar que la API lo marque ella misma.
    // IMPORTANTE: usar el score ya actualizado en `updates` si existe, no el viejo de `matches`, para no perder goles de último momento
    for (const [matchId, match] of Object.entries(matches)) {
      if (match.status === 'live') {
        const liveEvent = events.find(e => `match_${e.idEvent}` === matchId);
        const currentStatus = liveEvent?.strStatus || '';
        // Si la API dice que sigue en juego (alargue o penales), no forzar cierre
        if (['ET', 'P', 'BT'].includes(currentStatus)) continue;

        const matchDate = match.matchDate?.toDate ? match.matchDate.toDate() : new Date(match.matchDate || 0);
        const hoursElapsed = (now - matchDate) / (1000 * 60 * 60);
        if (hoursElapsed >= 2.5) {
          // Usar el score más reciente: el de 'updates' (recién sincronizado) tiene prioridad sobre el viejo de Firestore
          const latest = updates[matchId] || match;
          const result = latest.homeScore > latest.awayScore ? '1' : latest.homeScore === latest.awayScore ? 'X' : '2';
          updates[matchId] = { ...match, ...latest, status: 'finished', result, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
          if (!newlyFinished.includes(matchId)) newlyFinished.push(matchId);
          updatedCount++;
        }
      }
    }

    if (updatedCount > 0) {
      const batch = db.batch();
      Object.entries(updates).forEach(([matchId, data]) => {
        batch.update(db.collection(tour.collection).doc(matchId), data);
      });
      await batch.commit();
      console.log(`   ✅ Guardado exitoso (${updatedCount} actualizados)`);
    } else {
      console.log(`   ℹ️  Sin cambios para guardar`);
    }

    // Cerrar predicciones de partidos recién terminados
    if (newlyFinished.length > 0) {
      console.log(`   🔒 Cerrando predicciones para ${newlyFinished.length} partidos terminados...`);
      await closePredictions(tournamentKey, newlyFinished);
    }

  } catch (error) {
    console.error(`❌ Error sincronizando ${tour.name}:`, error);
  }
}

async function syncAll() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔄 SYNC AUTOMÁTICO - ${new Date().toLocaleString('es-AR')}`);
  console.log(`${'='.repeat(60)}`);
  try {
    await syncTournament('mundial');
    await syncTournament('liga');
    console.log(`\n✅ SINCRONIZACIÓN COMPLETADA`);
  } catch (error) {
    console.error('❌ Error en sincronización general:', error);
  }
}

let activeInterval = null;
let isActiveModeOn = false;

async function hasMatchesSoon() {
  const now = new Date();
  const windowFuture = new Date(now.getTime() + 2 * 60 * 60 * 1000);  // 2hs hacia adelante
  const windowPast = new Date(now.getTime() - 8 * 60 * 60 * 1000);    // 8hs hacia atrás (cubre partidos del Mundial a cualquier horario)

  for (const tournamentKey of Object.keys(TOURNAMENTS)) {
    const tour = TOURNAMENTS[tournamentKey];
    try {
      // Primero: verificar si hay partidos con status 'live' (siempre activo)
      const liveSnapshot = await db.collection(tour.collection)
        .where('status', '==', 'live')
        .get();
      if (!liveSnapshot.empty) {
        console.log(`   ⚡ Partido en vivo detectado en ${tour.name}`);
        return true;
      }

      // Segundo: verificar ventana ampliada de partidos no terminados
      const snapshot = await db.collection(tour.collection)
        .where('matchDate', '>=', windowPast)
        .where('matchDate', '<=', windowFuture)
        .get();

      for (const doc of snapshot.docs) {
        const m = doc.data();
        if (m.status !== 'finished') {
          console.log(`   ⚡ Partido pendiente detectado: ${m.homeName} vs ${m.awayName}`);
          return true;
        }
        // Período de gracia: seguir sincronizando partidos recién marcados 'finished' por 30 min más,
        // para capturar correcciones de TheSportsDB (goles de tiempo añadido que llegan tarde)
        const updatedAt = m.updatedAt?.toDate ? m.updatedAt.toDate() : null;
        if (updatedAt) {
          const minsSinceUpdate = (now - updatedAt) / (1000 * 60);
          if (minsSinceUpdate <= 30) {
            console.log(`   ⚡ Partido en período de gracia (recién finalizado): ${m.homeName} vs ${m.awayName}`);
            return true;
          }
        }
      }
    } catch(e) {}
  }
  return false;
}

async function smartSync() {
  const soon = await hasMatchesSoon();

  if (soon && !isActiveModeOn) {
    // Activar modo cada 5 minutos
    console.log('⚡ Partidos próximos detectados — activando sync cada 5 minutos');
    isActiveModeOn = true;
    if (activeInterval) clearInterval(activeInterval);
    activeInterval = setInterval(async () => {
      await syncAll();
      const stillSoon = await hasMatchesSoon();
      if (!stillSoon) {
        console.log('😴 Sin partidos próximos — volviendo a modo pasivo (60 min)');
        isActiveModeOn = false;
        clearInterval(activeInterval);
        activeInterval = setInterval(smartSync, 60 * 60 * 1000);
      }
    }, 5 * 60 * 1000);
    await syncAll();
  } else if (!soon) {
    console.log('😴 Sin partidos próximos — próximo chequeo en 60 minutos');
  }
}

console.log('🚀 Servidor de sincronización iniciado');
console.log('⏰ Modo inteligente: sync cada 5 min con partidos, cada 60 min sin ellos');
// Siempre sincronizar al arrancar
syncAll().then(() => {
  smartSync();
  // Chequeo pasivo cada 60 minutos
  activeInterval = setInterval(smartSync, 60 * 60 * 1000);
});

const PORT = process.env.PORT || 3000;
const http = require('http');

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/health') { res.writeHead(200); res.end('OK'); return; }

  // Endpoint para forzar sincronización completa
  if (req.url === '/sync-force' && req.method === 'GET') {
    try {
      await syncAll();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Sincronización forzada completada' }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Endpoint para resetear contraseña de usuario
  if (req.url === '/reset-password' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { uid, newPassword, adminToken } = JSON.parse(body);
        if (!uid || !newPassword || !adminToken) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Faltan parámetros' }));
          return;
        }
        // Verificar que el token es de un admin
        const decoded = await admin.auth().verifyIdToken(adminToken);
        const adminDoc = await db.collection('users').doc(decoded.uid).get();
        const adminData = adminDoc.data();
        if (!adminData || (!adminData.isAdmin && !adminData.groupAdmin)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'No autorizado' }));
          return;
        }
        // Si es group admin, verificar que el usuario pertenece a su grupo
        if (!adminData.isAdmin && adminData.groupAdmin) {
          const userDoc = await db.collection('users').doc(uid).get();
          if (!userDoc.exists || userDoc.data().groupId !== adminData.groupId) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Usuario no pertenece a tu grupo' }));
            return;
          }
        }
        // Cambiar contraseña usando Firebase Admin SDK
        await admin.auth().updateUser(uid, { password: newPassword });
        console.log(`🔑 Contraseña actualizada para uid: ${uid} por admin: ${decoded.uid}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        console.error('❌ Error reset-password:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Endpoint para forzar importación de partidos nuevos
  if (req.url === '/import-next' && req.method === 'GET') {
    try {
      let imported = 0;
      for (const tournamentKey of Object.keys(TOURNAMENTS)) {
        const tour = TOURNAMENTS[tournamentKey];
        const nextRes = await axios.get(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsnextleague.php?id=${tour.leagueId}`);
        const nextEvents = nextRes.data.events || [];
        if (nextEvents.length > 0) {
          await importNewMatches(tournamentKey, nextEvents);
          const roundNum = nextEvents[0].intRound;
          if (roundNum) {
            const roundRes = await axios.get(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsround.php?id=${tour.leagueId}&r=${roundNum}&s=${tour.season}`);
            const roundEvents = roundRes.data.events || [];
            await importNewMatches(tournamentKey, roundEvents);
            imported += roundEvents.length;
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `Importación completada. ${imported} partidos procesados.` }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (req.url === '/tabla-debug') {
    try {
      const response = await axios.get(
        'https://info.afa.org.ar/deposito/html/v3/htmlCenter/data/deportes/futbol/primeraa/pages/es/posiciones.html?h=dfMc-page-59a3b20e-3e75-4f44-a97a-793483652770',
        { headers: { 'Referer': 'https://www.afa.com.ar' }, timeout: 10000 }
      );
      const html = response.data;
      const idx = html.indexOf('class="linea e_');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(idx >= 0 ? html.substring(idx, idx + 2000) : 'No se encontraron filas. HTML length: ' + html.length);
    } catch (error) { res.writeHead(500); res.end(error.message); }
    return;
  }

  if (req.url === '/tabla-liga') {
    try {
      console.log('📊 Fetching tabla Liga Argentina desde AFA...');
      const response = await axios.get(
        'https://info.afa.org.ar/deposito/html/v3/htmlCenter/data/deportes/futbol/primeraa/pages/es/posiciones.html?h=dfMc-page-59a3b20e-3e75-4f44-a97a-793483652770',
        { headers: { 'Referer': 'https://www.afa.com.ar' }, timeout: 10000 }
      );
      const html = response.data;
      const rows = [];
      const trRegex = /<tr class="linea e_(\d+)">([\s\S]*?)<\/tr>\n/g;
      let trMatch;
      while ((trMatch = trRegex.exec(html)) !== null) {
        const teamId = trMatch[1];
        const rowHtml = trMatch[2];
        const posMatch = rowHtml.match(/<td class="pos">(\d+)<\/td>/);
        const nameMatch = rowHtml.match(/data-team-id="\d+">(.*?)<\/a>/);
        const ptsMatch = rowHtml.match(/rounded-circle">(\d+)<\/span>/);
        const allNums = [...rowHtml.matchAll(/border-primary">\s*(\d+)\s*<\/div>/g)].map(m => parseInt(m[1]));
        const dfMatch = rowHtml.match(/<td class="d-none d-sm-table-cell">\s*(-?\d+)\s*<\/td>/);
        if (posMatch && nameMatch && ptsMatch && allNums.length >= 4) {
          rows.push({ teamId, pos: parseInt(posMatch[1]), name: nameMatch[1].trim(), pts: parseInt(ptsMatch[1]), pj: allNums[0]||0, pg: allNums[1]||0, pe: allNums[2]||0, pp: allNums[3]||0, df: dfMatch ? parseInt(dfMatch[1]) : 0 });
        }
      }
      let grupoA = [], grupoB = [], inGrupoB = false;
      for (let i = 0; i < rows.length; i++) {
        if (i > 0 && rows[i].pos === 1 && !inGrupoB) inGrupoB = true;
        if (inGrupoB) grupoB.push(rows[i]); else grupoA.push(rows[i]);
      }
      grupoA = grupoA.slice(0, 15);
      grupoB = grupoB.slice(0, 15);
      const result = { grupos: [{ nombre: 'Grupo A', equipos: grupoA }, { nombre: 'Grupo B', equipos: grupoB }], updatedAt: new Date().toISOString() };
      console.log(`📊 Tabla obtenida: ${grupoA.length} equipos Grupo A, ${grupoB.length} equipos Grupo B`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('❌ Error fetching tabla:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  res.writeHead(200);
  res.end('Sync server running...');
});

server.listen(PORT, () => { console.log(`\n📌 Servidor escuchando en puerto ${PORT}`); });
