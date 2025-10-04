const bcrypt = require('bcrypt');
const { runQuery, getQuery, allQuery } = require('../database/database');

class User {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.email = data.email;
    this.passwordHash = data.password_hash;
    this.isActive = data.is_active;
    this.userCode = data.user_code;
    this.totpSecret = data.totp_secret;
    this.totpEnabled = data.totp_enabled;
    this.totpBackupCodes = data.totp_backup_codes;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  static async create(name, email, password) {
    try {
      const hashedPassword = password.includes(':') ? password : await bcrypt.hash(password, 12);
      
      const result = await runQuery(
        `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [name, email, hashedPassword]
      );

      // Fetch the created user
      const userData = await getQuery(
        `SELECT * FROM users WHERE id = $1`,
        [result.rows[0].id]
      );

      return new User(userData);
    } catch (error) {
      console.error('Error creating user:', error);
      throw error;
    }
  }

  async comparePassword(candidatePassword) {
    return bcrypt.compare(candidatePassword, this.passwordHash);
  }

  static async findUserByEmail(email) {
    try {
      const userData = await getQuery(
        `SELECT * FROM users WHERE email = $1 AND is_active = true`,
        [email]
      );

      if (!userData) {
        return null;
      }

      return new User(userData);
    } catch (error) {
      console.error('Error finding user by email:', error);
      throw error;
    }
  }

  static async findUserById(id) {
    try {
      const userData = await getQuery(
        `SELECT * FROM users WHERE id = $1 AND is_active = true`,
        [id]
      );

      if (!userData) {
        return null;
      }

      return new User(userData);
    } catch (error) {
      console.error('Error finding user by ID:', error);
      throw error;
    }
  }

  static async getAllUsers() {
    try {
      const usersData = await allQuery(
        `SELECT id, name, email, is_active, created_at, updated_at FROM users ORDER BY created_at DESC`
      );

      return usersData.map(userData => ({
        id: userData.id,
        name: userData.name,
        email: userData.email,
        isActive: userData.is_active,
        createdAt: userData.created_at,
        updatedAt: userData.updated_at
      }));
    } catch (error) {
      console.error('Error getting all users:', error);
      throw error;
    }
  }

  static async updateUser(id, updateData) {
    try {
      const allowedFields = ['name', 'email'];
      const updates = [];
      const values = [];

      let paramIndex = 1;
      for (const field of allowedFields) {
        if (updateData[field] !== undefined) {
          updates.push(`${field} = $${paramIndex}`);
          values.push(updateData[field]);
          paramIndex++;
        }
      }

      if (updates.length === 0) {
        throw new Error('No valid fields to update');
      }

      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);

      await runQuery(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
        values
      );

      // Fetch the updated user
      const userData = await getQuery(
        `SELECT * FROM users WHERE id = $1`,
        [id]
      );

      return new User(userData);
    } catch (error) {
      console.error('Error updating user:', error);
      throw error;
    }
  }

  static async deactivateUser(id) {
    try {
      await runQuery(
        `UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id]
      );

      // Fetch the updated user
      const userData = await getQuery(
        `SELECT * FROM users WHERE id = $1`,
        [id]
      );

      return new User(userData);
    } catch (error) {
      console.error('Error deactivating user:', error);
      throw error;
    }
  }

  static async updatePassword(id, hashedPassword) {
    try {
      await runQuery(
        `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [hashedPassword, id]
      );

      return true;
    } catch (error) {
      console.error('Error updating password:', error);
      throw error;
    }
  }

  static async enableTOTP(id, secret, backupCodes) {
    try {
      await runQuery(
        `UPDATE users SET totp_secret = $1, totp_enabled = true, totp_backup_codes = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
        [secret, backupCodes, id]
      );

      return true;
    } catch (error) {
      console.error('Error enabling TOTP:', error);
      throw error;
    }
  }

  static async disableTOTP(id) {
    try {
      await runQuery(
        `UPDATE users SET totp_secret = NULL, totp_enabled = false, totp_backup_codes = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id]
      );

      return true;
    } catch (error) {
      console.error('Error disabling TOTP:', error);
      throw error;
    }
  }

  static async verifyTOTP(id, code) {
    try {
      const user = await User.findUserById(id);
      if (!user || !user.totpSecret) {
        return false;
      }

      const speakeasy = require('speakeasy');
      return speakeasy.totp.verify({
        secret: user.totpSecret,
        encoding: 'base32',
        token: code,
        window: 2
      });
    } catch (error) {
      console.error('Error verifying TOTP:', error);
      return false;
    }
  }

  static async generateUserCode() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 100;

    while (!isUnique && attempts < maxAttempts) {
      // Generate a random code between 3-8 characters
      const length = Math.floor(Math.random() * 6) + 3; // 3-8 characters
      code = '';
      for (let i = 0; i < length; i++) {
        code += characters.charAt(Math.floor(Math.random() * characters.length));
      }

      // Check if code is unique
      const existingUser = await getQuery(
        `SELECT id FROM users WHERE user_code = $1`,
        [code]
      );

      if (!existingUser) {
        isUnique = true;
      }
      attempts++;
    }

    if (!isUnique) {
      throw new Error('Unable to generate unique user code after maximum attempts');
    }

    return code;
  }

  static async findUserByCode(userCode) {
    try {
      const userData = await getQuery(
        `SELECT * FROM users WHERE user_code = $1 AND is_active = true`,
        [userCode]
      );

      if (!userData) {
        return null;
      }

      return new User(userData);
    } catch (error) {
      console.error('Error finding user by code:', error);
      throw error;
    }
  }

  static async setUserCode(userId, userCode) {
    try {
      // Validate user code format
      if (!userCode || userCode.length < 3 || userCode.length > 8) {
        throw new Error('User code must be between 3 and 8 characters');
      }

      // Check if code is already taken
      const existingUser = await getQuery(
        `SELECT id FROM users WHERE user_code = $1 AND id != $2`,
        [userCode, userId]
      );

      if (existingUser) {
        throw new Error('User code is already taken');
      }

      await runQuery(
        `UPDATE users SET user_code = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [userCode, userId]
      );

      return true;
    } catch (error) {
      console.error('Error setting user code:', error);
      throw error;
    }
  }

  static async clearUserCode(userId) {
    try {
      await runQuery(
        `UPDATE users SET user_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [userId]
      );

      return true;
    } catch (error) {
      console.error('Error clearing user code:', error);
      throw error;
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      email: this.email,
      isActive: this.isActive,
      userCode: this.userCode,
      totpEnabled: this.totpEnabled,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

module.exports = User;
