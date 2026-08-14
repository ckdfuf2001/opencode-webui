import type { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'


let transactionQueue: Promise<unknown> = Promise.resolve()
let transactionActive = false

export function withTransactionAsync<T>(
  db: Database,
  fn: (db: Database) => Promise<T>
): Promise<T> {
  if (transactionActive) {
    return fn(db)
  }

  const run = async (): Promise<T> => {
    db.exec('BEGIN TRANSACTION')
    transactionActive = true
    try {
      const result = await fn(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch (rollbackError) {
        logger.error('Transaction rollback failed:', rollbackError)
      }
      logger.error('Transaction rolled back:', error)
      throw error
    } finally {
      transactionActive = false
    }
  }

  const result = transactionQueue.then(run, run)
  transactionQueue = result.catch(() => {})
  return result
}
