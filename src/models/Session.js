const { getDb, Collections, timestampToDate, dateToTimestamp } = require('../database/firestore');
const { FieldValue } = require('@google-cloud/firestore');

class Session {
  constructor(data) {
    this.id = data.id;
    this.userId = data.userId || data.user_id;
    this.createdAt = timestampToDate(data.createdAt || data.created_at);
    this.lastActivity = timestampToDate(data.lastActivity || data.last_activity);
    this.isActive = data.isActive !== undefined ? data.isActive : data.is_active;
    this.characterCount = data.characterCount !== undefined ? data.characterCount : data.character_count;
  }

  static async create(sessionId, userId = null) {
    try {
      const db = getDb();
      const sessionsRef = db.collection(Collections.SESSIONS);
      
      const now = dateToTimestamp(new Date());
      const sessionData = {
        userId,
        createdAt: now,
        lastActivity: now,
        isActive: true,
        characterCount: 0,
      };

      // Use the provided sessionId as the document ID
      await sessionsRef.doc(sessionId).set(sessionData);
      
      return new Session({
        id: sessionId,
        ...sessionData,
      });
    } catch (error) {
      console.error('Error creating session:', error);
      throw error;
    }
  }

  static async findById(sessionId) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.SESSIONS).doc(sessionId);
      const doc = await docRef.get();

      if (!doc.exists) {
        return null;
      }

      const data = doc.data();
      if (!data.isActive) {
        return null;
      }

      return new Session({
        id: doc.id,
        ...data,
      });
    } catch (error) {
      console.error('Error finding session:', error);
      throw error;
    }
  }

  static async findByUserId(userId) {
    try {
      const db = getDb();
      const sessionsRef = db.collection(Collections.SESSIONS);
      
      const snapshot = await sessionsRef
        .where('userId', '==', userId)
        .where('isActive', '==', true)
        .orderBy('createdAt', 'desc')
        .get();

      return snapshot.docs.map(doc => new Session({
        id: doc.id,
        ...doc.data(),
      }));
    } catch (error) {
      console.error('Error finding sessions by user:', error);
      throw error;
    }
  }

  static async updateLastActivity(sessionId) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.SESSIONS).doc(sessionId);
      
      await docRef.update({
        lastActivity: dateToTimestamp(new Date()),
      });
      
      return true;
    } catch (error) {
      console.error('Error updating last activity:', error);
      return false;
    }
  }
  
  static async updateCharacterCount(characterCount, sessionId) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.SESSIONS).doc(sessionId);
      
      await docRef.update({
        characterCount: FieldValue.increment(characterCount),
      });
      
      return true;
    } catch (error) {
      console.error('Error updating character count:', error);
      return false;
    }
  }

  static async deactivate(sessionId) {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.SESSIONS).doc(sessionId);
      
      await docRef.update({
        isActive: false,
      });
      
      return true;
    } catch (error) {
      console.error('Error deactivating session:', error);
      return false;
    }
  }

  static async deactivateAllForUser(userId) {
    try {
      const db = getDb();
      const sessionsRef = db.collection(Collections.SESSIONS);
      
      const snapshot = await sessionsRef
        .where('userId', '==', userId)
        .where('isActive', '==', true)
        .get();

      const batch = db.batch();
      snapshot.docs.forEach(doc => {
        batch.update(doc.ref, { isActive: false });
      });
      
      await batch.commit();
      return true;
    } catch (error) {
      console.error('Error deactivating sessions for user:', error);
      return false;
    }
  }

  static async deactivateAllForUserExcept(userId, exceptSessionId) {
    try {
      const db = getDb();
      const sessionsRef = db.collection(Collections.SESSIONS);
      
      const snapshot = await sessionsRef
        .where('userId', '==', userId)
        .where('isActive', '==', true)
        .get();

      const batch = db.batch();
      snapshot.docs.forEach(doc => {
        if (doc.id !== exceptSessionId) {
          batch.update(doc.ref, { isActive: false });
        }
      });
      
      await batch.commit();
      return true;
    } catch (error) {
      console.error('Error deactivating sessions for user except current:', error);
      return false;
    }
  }

  static async getActiveSessionCount() {
    try {
      const db = getDb();
      const sessionsRef = db.collection(Collections.SESSIONS);
      
      const snapshot = await sessionsRef
        .where('isActive', '==', true)
        .count()
        .get();
      
      return snapshot.data().count;
    } catch (error) {
      console.error('Error getting active session count:', error);
      return 0;
    }
  }

  static async getActiveSessionsForUser(userId) {
    try {
      const db = getDb();
      const sessionsRef = db.collection(Collections.SESSIONS);
      
      const snapshot = await sessionsRef
        .where('userId', '==', userId)
        .where('isActive', '==', true)
        .orderBy('createdAt', 'desc')
        .get();

      return snapshot.docs.map(doc => new Session({
        id: doc.id,
        ...doc.data(),
      }));
    } catch (error) {
      console.error('Error getting active sessions for user:', error);
      return [];
    }
  }

  static async cleanupExpired() {
    try {
      const db = getDb();
      const sessionsRef = db.collection(Collections.SESSIONS);
      
      // Calculate 24 hours ago
      const twentyFourHoursAgo = new Date();
      twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
      const cutoffTimestamp = dateToTimestamp(twentyFourHoursAgo);
      
      const snapshot = await sessionsRef
        .where('isActive', '==', true)
        .where('lastActivity', '<', cutoffTimestamp)
        .get();

      if (snapshot.empty) {
        return 0;
      }

      const batch = db.batch();
      snapshot.docs.forEach(doc => {
        batch.update(doc.ref, { isActive: false });
      });
      
      await batch.commit();
      return snapshot.size;
    } catch (error) {
      console.error('Error cleaning up expired sessions:', error);
      return 0;
    }
  }
}

module.exports = Session;
