const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Session = require('../models/Session');
const config = require('../config');

const JWT_SECRET = config.JWT_SECRET;

/**
 * Middleware to authenticate JWT tokens
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      error: 'Access token required',
      code: 'MISSING_TOKEN'
    });
  }

  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) {
      console.error('JWT verification error:', err.message);
      return res.status(403).json({ 
        error: 'Invalid or expired token',
        code: 'INVALID_TOKEN'
      });
    }

    try {
      const user = await User.findUserById(decoded.userId);
      if (!user || !user.isActive) {
        return res.status(403).json({ 
          error: 'User not found or deactivated',
          code: 'USER_NOT_FOUND'
        });
      }

      req.user = user;
      next();
    } catch (error) {
      console.error('Database error during authentication:', error);
      return res.status(500).json({ 
        error: 'Authentication failed',
        code: 'DATABASE_ERROR'
      });
    }
  });
};

/**
 * Middleware to authenticate WebSocket connections
 * Supports both JWT authentication and user code-based connections
 */
const authenticateSocket = async (socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
  const userCode = socket.handshake.auth.userCode;

  if (userCode) {
    // Validate user code format (3-8 characters, alphanumeric)
    if (!/^[A-Z0-9]{3,8}$/.test(userCode)) {
      console.log(`❌ Invalid user code format: ${userCode}`);
      return next(new Error('Invalid user code format'));
    }
    
    try {
      const user = await User.findUserByCode(userCode);
      if (!user) {
        console.log(`❌ User not found for code: ${userCode}`);
        return next(new Error('User not found for this code'));
      }
      
      socket.userCode = userCode;
      socket.user = user;
      socket.needsTokenRefresh = false;
    } catch (error) {
      console.error('Error validating user code:', error);
      return next(new Error('User code validation failed'));
    }
  }

  if (token) {
    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
      if (err) {
        if (err.name === 'TokenExpiredError') {
          console.log('🔄 Token expired, allowing connection with user code-only mode');
          socket.user = null;
          socket.needsTokenRefresh = true;
          return next();
        }
        
        console.error('❌ JWT verification error:', err.message);
        return next(new Error('Invalid token'));
      }

      try {
        const user = await User.findUserById(decoded.userId);
        if (!user || !user.isActive) {
          return next(new Error('User not found or deactivated'));
        }

        socket.user = user;
        socket.needsTokenRefresh = false;
        next();
      } catch (error) {
        console.error('Database error during socket authentication:', error);
        return next(new Error('Authentication failed'));
      }
    });
  } else if (userCode) {
    // User code authentication successful
    next();
  } else {
    return next(new Error('Authentication token or user code required'));
  }
};

/**
 * Generate JWT token for user
 */
const generateToken = (user) => {
  return jwt.sign(
    { 
      userId: user.id,
      email: user.email 
    },
    JWT_SECRET,
    { 
      expiresIn: config.JWT_ACCESS_EXPIRES_IN,
      issuer: 'scribe-backend',
      audience: 'scribe-frontend'
    }
  );
};

/**
 * Generate refresh token for user
 */
const generateRefreshToken = (user) => {
  return jwt.sign(
    { 
      userId: user.id,
      type: 'refresh'
    },
    JWT_SECRET,
    { 
      expiresIn: config.JWT_REFRESH_EXPIRES_IN,
      issuer: 'scribe-backend',
      audience: 'scribe-frontend'
    }
  );
};

/**
 * Verify refresh token
 */
const verifyRefreshToken = (token) => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'refresh') {
      throw new Error('Invalid token type');
    }
    return decoded;
  } catch (error) {
    throw new Error('Invalid refresh token');
  }
};

/**
 * Optional authentication middleware - doesn't fail if no token
 */
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    req.user = null;
    return next();
  }

  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) {
      req.user = null;
      return next();
    }

    try {
      const user = await User.findUserById(decoded.userId);
      if (!user || !user.isActive) {
        req.user = null;
        return next();
      }

      req.user = user;
      next();
    } catch (error) {
      console.error('Database error during optional authentication:', error);
      req.user = null;
      next();
    }
  });
};

module.exports = {
  authenticateToken,
  authenticateSocket,
  generateToken,
  generateRefreshToken,
  verifyRefreshToken,
  optionalAuth
};
