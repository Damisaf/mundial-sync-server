const admin = require('firebase-admin');
const axios = require('axios');

// Inicializar Firebase desde variable de entorno
let serviceAccount;

if (process.env.FIREBASE_KEY_BASE64) {
  // Si está en base64 (Render)
  const keyString = Buffer.from(process.env.FIREBASE_KEY_BASE64, 'base64').toString('utf8');
  serviceAccount = JSON.parse(keyString);
} else {
  // Si está en archivo local (desarrollo)
  serviceAccount = require('./firebase-key.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://mundial-2026-5aa8a.firebaseio.com'
});

const db = admin.firestore();
const SPORTSDB_KEY = '123';

// Torneos a sincronizar
const TOURNAMENTS = {
  mundial: {
    name: 'Mundial 2026',
    collection: 'matches',
    leagueId: 4429,
    season: 2026
  },
  liga: {
    name: 'Liga Argentina',
    collection: 'matches_liga',
    leagueId: 4406,
    season: 2026
  }
};

// Función para obtener datos de TheSportsDB
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

// Función para sincronizar un torneo
async function syncTournament(tournamentKey) {
  const tour = TOURNAMENTS[tournamentKey];
  console.log(`\n📡 Sincronizando ${tour.name}...`);

  try {
    // Obtener todos los matches del torneo
    const snapshot = await db.collection(tour.collection).get();
    const matches = {};

    snapshot.forEach(doc => {
      matches[doc.id] = doc.data();
    });

    console.log(`   📊 Total de matches en BD: ${Object.keys(matches).length}`);

    // Detectar ronda actual
    const now = new Date();
    let roundToSync = null;
    let earliestFutureMatch = null;

    Object.values(matches).forEach(m => {
      const d = m.matchDate?.toDate ? m.matchDate.toDate() : new Date(m.matchDate || 0);

      if (d <= now && !m.result) {
        if (!roundToSync || d > new Date(roundToSync.matchDate || 0)) {
          roundToSync = m;
        }
      }

      if (d > now) {
        if (!earliestFutureMatch || d < new Date(earliestFutureMatch.matchDate || 0)) {
          earliestFutureMatch = m;
        }
      }
    });

    let roundNum = null;
    if (roundToSync?.stage) {
      roundNum = roundToSync.stage.replace(/\D/g, '');
    } else if (earliestFutureMatch?.stage) {
      roundNum = earliestFutureMatch.stage.replace(/\D/g, '');
    }

    if (!roundNum) {
      console.log(`   ⚠️  No se encontró ronda para sincronizar`);
      return;
    }

    console.log(`   📋 Sincronizando ronda ${roundNum}...`);

    // Obtener datos de TheSportsDB
    const events = await fetchRoundData(tour.leagueId, roundNum, tour.season);
    console.log(`   ✅ ${events.length} eventos obtenidos`);

    // Procesar resultados
    let updatedCount = 0;
    const updates = {};

    events.forEach(e => {
      const homeScore = e.intHomeScore !== null && e.intHomeScore !== '' ? parseInt(e.intHomeScore) : null;
      const awayScore = e.intAwayScore !== null && e.intAwayScore !== '' ? parseInt(e.intAwayScore) : null;

      if (homeScore === null || awayScore === null) return;

      const matchId = `match_${e.idEvent}`;
      const cached = matches[matchId];
      if (!cached) return;

      const hasChanged = cached.homeScore !== homeScore || cached.awayScore !== awayScore || cached.status !== (e.strStatus === 'Match Finished' ? 'finished' : 'live');
      if (hasChanged) {
        const isFinished = e.strStatus === 'Match Finished';
        const result = isFinished ? (homeScore > awayScore ? '1' : homeScore === awayScore ? 'X' : '2') : undefined;

        const update = {
          homeScore,
          awayScore,
          status: isFinished ? 'finished' : 'live',
          fixtureId: e.idEvent,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (result !== undefined) update.result = result;

        updates[matchId] = update;

        console.log(`   ${isFinished ? '✅' : '🔴'} ${e.strHomeTeam} ${homeScore}-${awayScore} ${e.strAwayTeam} [${isFinished ? 'FINALIZADO' : 'EN VIVO'}]`);
        updatedCount++;
      }
    });

    // Guardar en Firebase
    if (updatedCount > 0) {
      console.log(`   💾 Guardando ${updatedCount} cambios en BD...`);

      const batch = db.batch();
      Object.entries(updates).forEach(([matchId, data]) => {
        const ref = db.collection(tour.collection).doc(matchId);
        batch.update(ref, data);
      });

      await batch.commit();
      console.log(`   ✅ Guardado exitoso (${updatedCount} actualizados)`);
    } else {
      console.log(`   ℹ️  Sin cambios para guardar`);
    }

  } catch (error) {
    console.error(`❌ Error sincronizando ${tour.name}:`, error);
  }
}

// Función principal
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

// Ejecutar sincronización cada 5 minutos
console.log('🚀 Servidor de sincronización iniciado');
console.log('⏰ Sincronizando cada 5 minutos...');

// Sincronizar inmediatamente al iniciar
syncAll();

// Luego cada 5 minutos (300000 ms)
setInterval(syncAll, 300000);

// Mantener el servidor activo
const PORT = process.env.PORT || 3000;
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else {
    res.writeHead(200);
    res.end('Sync server running...');
  }
});

server.listen(PORT, () => {
  console.log(`\n📌 Servidor escuchando en puerto ${PORT}`);
});
