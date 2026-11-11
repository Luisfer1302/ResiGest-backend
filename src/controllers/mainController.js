const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'resigest_secret_key_2026';

// ----------------------------------------------------
// 1. AUTENTICACIÓN
// ----------------------------------------------------
exports.login = async (req, res) => {
    try {
        const { username, password } = req.body;

        console.log("\n--- INTENTO DE LOGIN ---");
        console.log("1. Username recibido:", JSON.stringify(username));
        console.log("2. Password recibido:", JSON.stringify(password));

        if (!username || !password) {
            console.log("-> ERROR: Falta usuario o contraseña");
            return res.status(400).json({ mensaje: 'Faltan credenciales obligatorias' });
        }

        const [rows] = await db.query(
            'SELECT * FROM usuarios WHERE username = ?',
            [username.trim()]
        );

        if (rows.length === 0) {
            console.log("-> ERROR: No existe ningún usuario con username =", username);
            return res.status(401).json({ mensaje: 'Credenciales incorrectas' });
        }

        const usuario = rows[0];
        console.log("3. Usuario encontrado en BD:", usuario.username);
        console.log("4. Hash en BD:", usuario.password_hash);

        // Limpiamos posibles espacios accidentales al escribir
        const passwordLimpia = password.trim();
        const coincide = await bcrypt.compare(passwordLimpia, usuario.password_hash);
        console.log("5. ¿Coincide la contraseña?:", coincide);

        if (!coincide) {
            console.log("-> ERROR: bcrypt.compare devolvió FALSE");
            return res.status(401).json({ mensaje: 'Credenciales incorrectas' });
        }

        const token = jwt.sign(
            {
                id: usuario.id,
                username: usuario.username,
                rol_id: usuario.rol_id || 1,
                categoria: usuario.categoria || 'TCAE'
            },
            JWT_SECRET,
            { expiresIn: '12h' }
        );

        const nombreMostrar = usuario.nombre_completo || usuario.nombre || usuario.username;

        console.log("-> LOGIN CORRECTO para:", nombreMostrar);
        res.json({
            token,
            usuario: {
                id: usuario.id,
                nombreCompleto: nombreMostrar,
                categoria: usuario.categoria || 'TCAE',
                rol: (usuario.rol_id === 1) ? 'ADMIN' : 'SANITARIO'
            }
        });
    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ mensaje: 'Error interno en el servidor', error: error.message });
    }
};

// ----------------------------------------------------
// 2. CENSO ASISTENCIAL DE RESIDENTES
// ----------------------------------------------------
exports.getResidentesPorPlanta = async (req, res) => {
    try {
        const { plantaId } = req.params;
        const [rows] = await db.query(
            `SELECT id, planta_id, habitacion, cama, nombre, apellidos, nhc, 
                    dieta, alergias, aislamiento, riesgo_caidas, estado_cama
             FROM residentes
             WHERE planta_id = ?
             ORDER BY habitacion ASC, cama ASC`,
            [plantaId]
        );

        res.json(rows);
    } catch (error) {
        console.error('Error al obtener residentes:', error);
        res.status(500).json({ mensaje: 'Error al consultar censo de planta', error: error.message });
    }
};

// ----------------------------------------------------
// 3. MEDICACIÓN Y SÁBANA HORARIA
// ----------------------------------------------------
exports.firmarTomaMedicacion = async (req, res) => {
    try {
        const { pauta_id, residente_id, toma, fecha } = req.body; 
        // fecha vendrá desde Android como 'YYYY-MM-DD'
        const usuario_id = req.usuario ? req.usuario.id : 1;

        if (!fecha) {
            return res.status(400).json({ mensaje: 'Falta la fecha de administración' });
        }

        // 1. Comprobamos si YA existe una administración real para esa pauta, toma y FECHA exacta
        const [admins] = await db.query(
            `SELECT id FROM administraciones_medicacion 
             WHERE pauta_id = ? AND residente_id = ? AND toma = ? AND DATE(fecha_hora) = ?`,
            [pauta_id, residente_id, toma, fecha]
        );

        const estaFirmado = admins.length > 0;

        if (estaFirmado) {
            // Si ya estaba firmado en esa fecha, lo BORRAMOS (Deshacer firma / Toggle)
            await db.query(`DELETE FROM administraciones_medicacion WHERE id = ?`, [admins[0].id]);
            res.json({ mensaje: `Firma de toma [${toma}] anulada el ${fecha}`, firmado: false });
        } else {
            // Si NO estaba firmado, lo INSERTAMOS
            const fechaHoy = new Date().toISOString().split('T')[0];
            let queryInsert = '';
            let paramsInsert = [];

            if (fecha === fechaHoy) {
                queryInsert = `INSERT INTO administraciones_medicacion (pauta_id, residente_id, usuario_id, toma, estado) VALUES (?, ?, ?, ?, 'ADMINISTRADO')`;
                paramsInsert = [pauta_id, residente_id, usuario_id, toma];
            } else {
                // Si están firmando un día del pasado, forzamos esa fecha en la base de datos
                queryInsert = `INSERT INTO administraciones_medicacion (pauta_id, residente_id, usuario_id, toma, estado, fecha_hora) VALUES (?, ?, ?, ?, 'ADMINISTRADO', ?)`;
                paramsInsert = [pauta_id, residente_id, usuario_id, toma, `${fecha} 12:00:00`];
            }

            await db.query(queryInsert, paramsInsert);
            res.json({ mensaje: `Toma [${toma}] firmada el ${fecha}`, firmado: true });
        }
    } catch (error) {
        console.error('Error al actualizar firma:', error);
        res.status(500).json({ mensaje: 'Error al actualizar firma', error: error.message });
    }
};

exports.registrarMedicacion = async (req, res) => {
    try {
        const { pauta_id, residente_id, estado, motivo_rechazo } = req.body;
        const usuario_id = req.usuario ? req.usuario.id : 1;

        await db.query(
            `INSERT INTO administraciones_medicacion (pauta_id, residente_id, usuario_id, toma, estado) 
             VALUES (?, ?, ?, 'GEN', ?)`,
            [pauta_id, residente_id, usuario_id, estado || 'ADMINISTRADO']
        );

        res.json({ mensaje: 'Medicación registrada' });
    } catch (error) {
        console.error('Error al registrar medicación genérica:', error);
        res.status(500).json({ mensaje: 'Error al registrar medicación', error: error.message });
    }
};

// ----------------------------------------------------
// 4. REGISTRO ASISTENCIAL: ELIMINACIÓN Y CAMBIO DE PAÑAL
// ----------------------------------------------------
exports.registrarEliminacion = async (req, res) => {
    try {
        const { residente_id, tipo, volumen_cantidad, caracteristicas, observaciones } = req.body;
        const usuario_id = req.usuario ? req.usuario.id : 1;
        const detalle = `${tipo} [${volumen_cantidad}] - ${caracteristicas}`;

        await db.query(
            `INSERT INTO registros_cuidados (residente_id, tipo_cuidado_id, usuario_id, valor_resultado, observaciones) 
             VALUES (?, 3, ?, ?, ?)`,
            [residente_id, usuario_id, detalle, observaciones || null]
        );

        res.json({ mensaje: 'Eliminación registrada correctamente' });
    } catch (error) {
        console.error('Error al registrar eliminación:', error);
        res.status(500).json({ mensaje: 'Error al registrar eliminación', error: error.message });
    }
};

// ----------------------------------------------------
// 5. REGISTRO ASISTENCIAL: INGESTAS Y LÍQUIDOS
// ----------------------------------------------------
exports.registrarIngesta = async (req, res) => {
    try {
        const { residente_id, comida, valoracion, liquidos_ml, observaciones } = req.body;
        const usuario_id = req.usuario ? req.usuario.id : 1;
        const texto = `${comida}: ${valoracion}${liquidos_ml ? ` | Líquidos: ${liquidos_ml} ml` : ''}`;

        await db.query(
            `INSERT INTO registros_cuidados (residente_id, tipo_cuidado_id, usuario_id, valor_resultado, observaciones) 
             VALUES (?, 9, ?, ?, ?)`,
            [residente_id, usuario_id, texto, observaciones || null]
        );

        res.json({ mensaje: 'Ingesta registrada correctamente' });
    } catch (error) {
        console.error('Error al registrar ingesta:', error);
        res.status(500).json({ mensaje: 'Error al registrar ingesta', error: error.message });
    }
};

// ----------------------------------------------------
// 6. CUIDADOS GENERALES (HIGIENE, MOVILIZACIONES, ETC.)
// ----------------------------------------------------
exports.registrarCuidado = async (req, res) => {
    try {
        const { residente_id, tipo_cuidado_id, valor_resultado, observaciones } = req.body;
        const usuario_id = req.usuario ? req.usuario.id : 1;

        await db.query(
            `INSERT INTO registros_cuidados (residente_id, tipo_cuidado_id, usuario_id, valor_resultado, observaciones) 
             VALUES (?, ?, ?, ?, ?)`,
            [residente_id, tipo_cuidado_id, usuario_id, valor_resultado, observaciones || null]
        );

        res.json({ mensaje: 'Cuidado registrado correctamente' });
    } catch (error) {
        console.error('Error al registrar cuidado:', error);
        res.status(500).json({ mensaje: 'Error al registrar cuidado general', error: error.message });
    }
};

// ----------------------------------------------------
// 7. CONSTANTES VITALES
// ----------------------------------------------------
exports.registrarConstantes = async (req, res) => {
    try {
        const {
            residente_id,
            ta_sistolica,
            ta_diastolica,
            frecuencia_cardiaca,
            saturacion_o2,
            temperatura,
            glucemia,
            diuresis_volumen_ml,
            observaciones
        } = req.body;

        const usuario_id = req.usuario ? req.usuario.id : 1;

        await db.query(
            `INSERT INTO constantes_vitales 
             (residente_id, usuario_id, ta_sistolica, ta_diastolica, frecuencia_cardiaca, saturacion_o2, temperatura, glucemia, diuresis_volumen_ml, observaciones)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                residente_id,
                usuario_id,
                ta_sistolica || null,
                ta_diastolica || null,
                frecuencia_cardiaca || null,
                saturacion_o2 || null,
                temperatura || null,
                glucemia || null,
                diuresis_volumen_ml || null,
                observaciones || null
            ]
        );

        res.json({ mensaje: 'Constantes guardadas correctamente' });
    } catch (error) {
        console.error('Error al guardar constantes:', error);
        res.status(500).json({ mensaje: 'Error al registrar constantes vitales', error: error.message });
    }
};

// ----------------------------------------------------
// 8. CRONOGRAMA / HISTORIAL CLÍNICO
// ----------------------------------------------------
exports.getHistorialResidente = async (req, res) => {
    try {
        const { id } = req.params;

        const queryCuidados = `
            SELECT rc.id, rc.fecha_hora, tc.nombre AS tipo_registro, tc.nombre AS titulo,
                   rc.valor_resultado AS resultado, rc.observaciones, u.username AS profesional
            FROM registros_cuidados rc
            INNER JOIN tipos_cuidado tc ON rc.tipo_cuidado_id = tc.id
            LEFT JOIN usuarios u ON rc.usuario_id = u.id
            WHERE rc.residente_id = ?
        `;

        const queryConstantes = `
            SELECT cv.id, cv.fecha_hora, 'Constantes Vitales' AS tipo_registro, 'Signos Vitales' AS titulo,
                   CONCAT_WS(' | ', 
                       IF(cv.ta_sistolica IS NOT NULL, CONCAT('TA: ', cv.ta_sistolica, '/', cv.ta_diastolica, ' mmHg'), NULL),
                       IF(cv.frecuencia_cardiaca IS NOT NULL, CONCAT('FC: ', cv.frecuencia_cardiaca, ' lpm'), NULL),
                       IF(cv.saturacion_o2 IS NOT NULL, CONCAT('Sat: ', cv.saturacion_o2, '%'), NULL),
                       IF(cv.temperatura IS NOT NULL, CONCAT('Tª: ', cv.temperatura, ' ºC'), NULL)
                   ) AS resultado,
                   cv.observaciones, u.username AS profesional
            FROM constantes_vitales cv
            LEFT JOIN usuarios u ON cv.usuario_id = u.id
            WHERE cv.residente_id = ?
        `;

        const queryMed = `
            SELECT am.id, am.fecha_hora, 'Medicación' AS tipo_registro, pm.farmaco AS titulo,
                   CONCAT('Toma: ', am.toma, ' - ', am.estado) AS resultado,
                   pm.dosis AS observaciones, u.username AS profesional
            FROM administraciones_medicacion am
            INNER JOIN pautas_medicacion pm ON am.pauta_id = pm.id
            LEFT JOIN usuarios u ON am.usuario_id = u.id
            WHERE am.residente_id = ?
        `;

        const [cuidados] = await db.query(queryCuidados, [id]);
        const [constantes] = await db.query(queryConstantes, [id]);
        const [medicaciones] = await db.query(queryMed, [id]);

        const combinados = [...cuidados, ...constantes, ...medicaciones].sort(
            (a, b) => new Date(b.fecha_hora) - new Date(a.fecha_hora)
        );

        res.json(combinados);
    } catch (error) {
        console.error('Error al obtener historial:', error);
        res.status(500).json({ mensaje: 'Error al consultar historial', error: error.message });
    }
};

// ----------------------------------------------------
// 9. OBTENER MEDICACIÓN DEL RESIDENTE (Por fecha)
// ----------------------------------------------------
exports.getMedicacionResidente = async (req, res) => {
    try {
        const { id } = req.params;
        // Si Android no manda fecha, usamos la de hoy por defecto
        const fecha = req.query.fecha || new Date().toISOString().split('T')[0]; 

        // 1. Obtenemos las pautas teóricas base del residente
        const [pautas] = await db.query(`SELECT * FROM pautas_medicacion WHERE residente_id = ?`, [id]);

        // 2. Obtenemos QUÉ se le ha dado realmente en ESA FECHA concreta
        const [administraciones] = await db.query(
            `SELECT pauta_id, toma FROM administraciones_medicacion 
             WHERE residente_id = ? AND DATE(fecha_hora) = ?`,
            [id, fecha]
        );

        // 3. Creamos un mapa rápido de lo administrado para cruzarlo
        const adminMap = {};
        administraciones.forEach(admin => {
            if (!adminMap[admin.pauta_id]) adminMap[admin.pauta_id] = {};
            adminMap[admin.pauta_id][admin.toma] = true;
        });

        // 4. Formateamos la respuesta para Kotlin
        const pautasFormateadas = pautas.map(row => ({
            ...row,
            pauta_desayuno: row.pauta_desayuno === 1,
            pauta_comida: row.pauta_comida === 1,
            pauta_merienda: row.pauta_merienda === 1,
            pauta_cena: row.pauta_cena === 1,
            pauta_noche: row.pauta_noche === 1,
            
            // Las FIRMAS ahora dependen del cruce con la tabla de historial para esa fecha
            firmado_desayuno: !!(adminMap[row.id] && adminMap[row.id]['DES']),
            firmado_comida: !!(adminMap[row.id] && adminMap[row.id]['COM']),
            firmado_merienda: !!(adminMap[row.id] && adminMap[row.id]['MER']),
            firmado_cena: !!(adminMap[row.id] && adminMap[row.id]['CEN']),
            firmado_noche: !!(adminMap[row.id] && adminMap[row.id]['NOC'])
        }));

        res.json(pautasFormateadas);
    } catch (error) {
        console.error('Error al obtener medicación:', error);
        res.status(500).json({ mensaje: 'Error al consultar medicación', error: error.message });
    }
};