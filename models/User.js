const bcrypt = require('bcrypt');
const { runQuery, getQuery, allQuery } = require('../config/database-postgres');

class User {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.email = data.email;
    this.passwordHash = data.password_hash;
    this.isActive = data.is_active;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  static async create(name, email, password) {
    try {
      const hashedPassword = await bcrypt.hash(password, 12);
      
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
        `SELECT * FROM users WHERE id = $1 AND is_active = 1`,
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

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      email: this.email,
      isActive: this.isActive,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

module.exports = User;
