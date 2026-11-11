const express = require('express');
const cors = require('cors');
require('dotenv').config();

const auth = require('./middleware/auth');
const ctrl = require('./controllers/mainController');

const app = express();
app.use(cors());
app.use(express.json());

// Ruta de comprobación de vida del servidor
app.get('/', (req, res) => {
  res.send('Servidor ResiGest API funcionando correctamente');
});

// Rutas de API
app.post('/api/login', ctrl.login);
app.get('/api/residentes/planta/:plantaId', auth, ctrl.getResidentesPorPlanta);
app.post('/api/registros/cuidados', auth, ctrl.registrarCuidado);
app.post('/api/registros/constantes', auth, ctrl.registrarConstantes);
app.get('/api/residentes/:id/historial', auth, ctrl.getHistorialResidente);
app.get('/api/residentes/:id/medicacion', auth, ctrl.getMedicacionResidente);
app.post('/api/registros/medicacion/firmar', auth, ctrl.firmarTomaMedicacion);
app.post('/api/registros/medicacion', auth, ctrl.registrarMedicacion);
app.post('/api/registros/eliminacion', auth, ctrl.registrarEliminacion);
app.post('/api/registros/ingestas', auth, ctrl.registrarIngesta);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Servidor ResiGest corriendo en http://localhost:${PORT}`);
});