const { getDb, Collections, timestampToDate, dateToTimestamp } = require('../database/firestore');
const crypto = require('crypto');

class PasswordResetToken {
  constructor(id, userId, token, expiresAt, used, createdAt) {
    this.id = id;
    this.userId = userId;
    this.token = token;
    this.expiresAt = timestampToDate(expiresAt);
    this.used = used;
    this.createdAt = timestampToDate(createdAt);
  }

  /**
   * Create a new password reset token
   * @param {string} userId - The user ID (Firestore document ID)
   * @param {number} expirationMinutes - Token expiration time in minutes (default: 60)
   * @returns {Promise<PasswordResetToken>}
   */
  static async create(userId, expirationMinutes = 60) {
    try {
      const db = getDb();
      const tokensRef = db.collection(Collections.PASSWORD_RESET_TOKENS);
      
      // Generate a secure random token
      const token = crypto.randomBytes(32).toString('hex');
      
      // Calculate expiration time
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + expirationMinutes);

      // Invalidate any existing tokens for this user using batch
      const existingTokensSnapshot = await tokensRef
        .where('userId', '==', userId)
        .where('used', '==', false)
        .get();

      const batch = db.batch();
      existingTokensSnapshot.docs.forEach(doc => {
        batch.update(doc.ref, { used: true });
      });

      // Create new token document
      const now = dateToTimestamp(new Date());
      const tokenData = {
        userId,
        token,
        expiresAt: dateToTimestamp(expiresAt),
        used: false,
        createdAt: now,
      };

      const newDocRef = tokensRef.doc();
      batch.set(newDocRef, tokenData);
      
      await batch.commit();

      return new PasswordResetToken(
        newDocRef.id,
        userId,
        token,
        expiresAt,
        false,
        new Date()
      );
    } catch (error) {
      console.error('Error creating password reset token:', error);
      throw error;
    }
  }

  /**
   * Find a valid token by token string
   * @param {string} token - The token string
   * @returns {Promise<PasswordResetToken|null>}
   */
  static async findByToken(token) {
    try {
      const db = getDb();
      const tokensRef = db.collection(Collections.PASSWORD_RESET_TOKENS);
      
      const snapshot = await tokensRef
        .where('token', '==', token)
        .where('used', '==', false)
        .limit(1)
        .get();

      if (snapshot.empty) {
        return null;
      }

      const doc = snapshot.docs[0];
      const data = doc.data();
      
      // Check if token is expired
      const expiresAt = timestampToDate(data.expiresAt);
      if (expiresAt < new Date()) {
        return null;
      }

      return new PasswordResetToken(
        doc.id,
        data.userId,
        data.token,
        data.expiresAt,
        data.used,
        data.createdAt
      );
    } catch (error) {
      console.error('Error finding password reset token:', error);
      throw error;
    }
  }

  /**
   * Mark a token as used
   * @param {string} token - The token string
   * @returns {Promise<boolean>}
   */
  static async markAsUsed(token) {
    try {
      const db = getDb();
      const tokensRef = db.collection(Collections.PASSWORD_RESET_TOKENS);
      
      const snapshot = await tokensRef
        .where('token', '==', token)
        .limit(1)
        .get();

      if (snapshot.empty) {
        return false;
      }

      await snapshot.docs[0].ref.update({ used: true });
      return true;
    } catch (error) {
      console.error('Error marking token as used:', error);
      throw error;
    }
  }

  /**
   * Clean up expired tokens
   * @returns {Promise<number>} Number of tokens cleaned up
   */
  static async cleanupExpired() {
    try {
      const db = getDb();
      const tokensRef = db.collection(Collections.PASSWORD_RESET_TOKENS);
      
      const now = dateToTimestamp(new Date());
      
      const snapshot = await tokensRef
        .where('expiresAt', '<', now)
        .get();

      if (snapshot.empty) {
        return 0;
      }

      const batch = db.batch();
      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
      });
      
      await batch.commit();
      return snapshot.size;
    } catch (error) {
      console.error('Error cleaning up expired tokens:', error);
      throw error;
    }
  }

  /**
   * Get all tokens for a user (for debugging)
   * @param {string} userId - The user ID
   * @returns {Promise<PasswordResetToken[]>}
   */
  static async findByUserId(userId) {
    try {
      const db = getDb();
      const tokensRef = db.collection(Collections.PASSWORD_RESET_TOKENS);
      
      const snapshot = await tokensRef
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .get();

      return snapshot.docs.map(doc => {
        const data = doc.data();
        return new PasswordResetToken(
          doc.id,
          data.userId,
          data.token,
          data.expiresAt,
          data.used,
          data.createdAt
        );
      });
    } catch (error) {
      console.error('Error finding tokens by user ID:', error);
      throw error;
    }
  }

  toJSON() {
    return {
      id: this.id,
      userId: this.userId,
      token: this.token,
      expiresAt: this.expiresAt,
      used: this.used,
      createdAt: this.createdAt
    };
  }
}

module.exports = PasswordResetToken;
