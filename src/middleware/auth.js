const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'resigest_super_secret_key_2026';

module.exports = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token de sesión requerido' });
  }

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Sesión caducada o token inválido' });
    }
    req.user = decoded;
    next();
  });
};