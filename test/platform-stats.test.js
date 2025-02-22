import assert from 'node:assert'
import pg from 'pg'
import { beforeEach, describe, it } from 'mocha'

import { DATABASE_URL } from '../lib/config.js'
import { migrateWithPgClient } from '../lib/migrate.js'
import {
  VALID_MEASUREMENT,
  VALID_STATION_ID
} from './helpers/test-data.js'
import {
  mapParticipantsToIds,
  updateDailyParticipants,
  updateStationsAndParticipants,
  updatePlatformStats,
  aggregateAndCleanUpRecentData,
  updateMonthlyActiveStationCount,
  refreshDatabase,
  updateTopMeasurementParticipants
} from '../lib/platform-stats.js'

/** @typedef {import('../lib/preprocess.js').Measurement} Measurement */

const createPgClient = async () => {
  const pgClient = new pg.Client({ connectionString: DATABASE_URL })
  await pgClient.connect()
  return pgClient
}

const VALID_STATION_ID_2 = VALID_STATION_ID.slice(0, -1) + '1'

describe('platform-stats', () => {
  let pgClient
  before(async () => {
    pgClient = await createPgClient()
    await migrateWithPgClient(pgClient)
  })

  let today
  beforeEach(async () => {
    await pgClient.query('DELETE FROM daily_stations')
    await pgClient.query('DELETE FROM recent_station_details')
    await pgClient.query('DELETE FROM daily_participants')
    await pgClient.query('DELETE FROM recent_participant_subnets')
    await pgClient.query('DELETE FROM recent_active_stations')
    await pgClient.query('DELETE FROM daily_platform_stats')
    await pgClient.query('DELETE FROM monthly_active_station_count')

    // empty `participants` table in such way that the next participants.id will be always 1
    await pgClient.query('TRUNCATE TABLE participants RESTART IDENTITY CASCADE')

    // Run all tests inside a transaction to ensure `now()` always returns the same value
    // See https://dba.stackexchange.com/a/63549/125312
    // This avoids subtle race conditions when the tests are executed around midnight.
    await pgClient.query('BEGIN TRANSACTION')
    today = await getCurrentDate()
  })

  afterEach(async () => {
    await pgClient.query('END TRANSACTION')
  })

  after(async () => {
    await pgClient.end()
  })

  describe('refreshDatabase', () => {
    it('runs provided functions and handles errors', async () => {
      const executedFunctions = []
      const errorMessages = []

      const successFunction = async () => {
        executedFunctions.push('successFunction')
      }

      const errorFunction = async () => {
        executedFunctions.push('errorFunction')
        throw new Error('Test error')
      }

      const originalConsoleError = console.error
      console.error = (message, error) => {
        errorMessages.push({ message, error })
      }

      await refreshDatabase(createPgClient, {
        functionsToRun: [successFunction, errorFunction]
      })

      console.error = originalConsoleError

      assert.deepStrictEqual(executedFunctions, ['successFunction', 'errorFunction'])
      assert.strictEqual(errorMessages.length, 1)
      assert.strictEqual(errorMessages[0].message, 'Error running function errorFunction:')
      assert.strictEqual(errorMessages[0].error.message, 'Test error')
    })
  })

  describe('updateStationsAndParticipants', () => {
    it('updates recent_station_details, recent_active_stations, and recent_participant_subnets', async () => {
      const participantsMap = await mapParticipantsToIds(pgClient, new Set(['0x10', '0x20']))

      /** @type {Measurement[]} */
      const allMeasurements = [
        { ...VALID_MEASUREMENT, stationId: 'station1', participantAddress: '0x10', inet_group: 'subnet1', taskingEvaluation: 'OK', consensusEvaluation: 'MAJORITY_RESULT' },
        { ...VALID_MEASUREMENT, stationId: 'station1', participantAddress: '0x10', inet_group: 'subnet2', taskingEvaluation: 'OK', consensusEvaluation: 'MAJORITY_RESULT' },
        { ...VALID_MEASUREMENT, stationId: 'station2', participantAddress: '0x20', inet_group: 'subnet3', taskingEvaluation: 'OK', consensusEvaluation: 'MAJORITY_RESULT' },
        { ...VALID_MEASUREMENT, stationId: 'station1', participantAddress: '0x10', inet_group: 'subnet1', taskingEvaluation: 'TASK_NOT_IN_ROUND' }
      ]

      await updateStationsAndParticipants(pgClient, allMeasurements, participantsMap, { day: today })

      const { rows: stationDetails } = await pgClient.query(`
        SELECT
          day::TEXT,
          station_id,
          participant_id,
          accepted_measurement_count,
          total_measurement_count
        FROM recent_station_details
        WHERE day = $1::DATE
        ORDER BY station_id, participant_id
      `, [today])

      assert.deepStrictEqual(stationDetails, [
        {
          day: today,
          station_id: 'station1',
          participant_id: 1,
          accepted_measurement_count: 2,
          total_measurement_count: 3
        },
        {
          day: today,
          station_id: 'station2',
          participant_id: 2,
          accepted_measurement_count: 1,
          total_measurement_count: 1
        }
      ])

      const { rows: activeStations } = await pgClient.query(`
        SELECT day::TEXT, station_id
        FROM recent_active_stations
        WHERE day = $1::DATE
        ORDER BY station_id
      `, [today])

      assert.deepStrictEqual(activeStations, [
        { day: today, station_id: 'station1' },
        { day: today, station_id: 'station2' }
      ])

      // Check recent_participant_subnets
      const { rows: participantSubnets } = await pgClient.query(`
        SELECT day::TEXT, participant_id, subnet
        FROM recent_participant_subnets
        WHERE day = $1::DATE
        ORDER BY participant_id, subnet
      `, [today])

      assert.deepStrictEqual(participantSubnets, [
        { day: today, participant_id: 1, subnet: 'subnet1' },
        { day: today, participant_id: 1, subnet: 'subnet2' },
        { day: today, participant_id: 2, subnet: 'subnet3' }
      ])
    })

    it('counts only majority measurements as accepted', async () => {
      const participantsMap = await mapParticipantsToIds(pgClient, new Set(['0x10']))

      /** @type {Measurement[]} */
      const allMeasurements = [
        { ...VALID_MEASUREMENT, participantAddress: '0x10', taskingEvaluation: 'OK', consensusEvaluation: 'MAJORITY_RESULT' },
        { ...VALID_MEASUREMENT, participantAddress: '0x10', taskingEvaluation: 'OK', consensusEvaluation: 'MINORITY_RESULT' }
      ]

      await updateStationsAndParticipants(pgClient, allMeasurements, participantsMap, { day: today })

      const { rows: stationDetails } = await pgClient.query(`
        SELECT
          day::TEXT,
          participant_id,
          accepted_measurement_count,
          total_measurement_count
        FROM recent_station_details
        WHERE day = $1::DATE
      `, [today])

      assert.deepStrictEqual(stationDetails, [
        {
          day: today,
          participant_id: 1,
          accepted_measurement_count: 1,
          total_measurement_count: 2
        }
      ])
    })

    it('updates top measurements participants yesterday materialized view', async () => {
      const validStationId3 = VALID_STATION_ID.slice(0, -1) + '2'
      const yesterday = await getYesterdayDate()

      const participantsMap = await mapParticipantsToIds(pgClient, new Set(['0x10', '0x20']))

      /** @type {Measurement[]} */
      const allMeasurements = [
        { ...VALID_MEASUREMENT, stationId: VALID_STATION_ID, participantAddress: '0x10', taskingEvaluation: 'OK', consensusEvaluation: 'MAJORITY_RESULT' },
        { ...VALID_MEASUREMENT, stationId: VALID_STATION_ID, participantAddress: '0x10', taskingEvaluation: 'OK', consensusEvaluation: 'MAJORITY_RESULT' },
        { ...VALID_MEASUREMENT, stationId: VALID_STATION_ID_2, participantAddress: '0x10', taskingEvaluation: 'OK', consensusEvaluation: 'MAJORITY_RESULT' },
        { ...VALID_MEASUREMENT, stationId: validStationId3, participantAddress: '0x20', taskingEvaluation: 'OK', consensusEvaluation: 'MAJORITY_RESULT' }
      ]

      await updateStationsAndParticipants(pgClient, allMeasurements, participantsMap, { day: yesterday })
      await updateTopMeasurementParticipants(pgClient)
      const { rows } = await pgClient.query('SELECT * FROM top_measurement_participants_yesterday_mv')

      assert.deepStrictEqual(rows, [
        {
          day: yesterday,
          participant_address: '0x10',
          inet_group_count: '1',
          station_count: '2',
          accepted_measurement_count: '3'
        },
        {
          day: yesterday,
          participant_address: '0x20',
          inet_group_count: '1',
          station_count: '1',
          accepted_measurement_count: '1'
        }
      ])
    })
  })

  describe('aggregateAndCleanupRecentData', () => {
    const assertDailySummary = async () => {
      const { rows } = await pgClient.query("SELECT * FROM daily_platform_stats WHERE day = CURRENT_DATE - INTERVAL '3 days'")
      assert.strictEqual(rows.length, 1)
      assert.deepStrictEqual(rows[0], {
        day: (await pgClient.query("SELECT (CURRENT_DATE - INTERVAL '3 days') as day")).rows[0].day,
        accepted_measurement_count: 15,
        total_measurement_count: 30,
        station_count: 2,
        participant_address_count: 2,
        inet_group_count: 2
      })

      const recentDetailsCount = await pgClient.query("SELECT COUNT(*) FROM recent_station_details WHERE day <= CURRENT_DATE - INTERVAL '2 days'")
      const recentSubnetsCount = await pgClient.query("SELECT COUNT(*) FROM recent_participant_subnets WHERE day <= CURRENT_DATE - INTERVAL '2 days'")
      assert.strictEqual(recentDetailsCount.rows[0].count, '0')
      assert.strictEqual(recentSubnetsCount.rows[0].count, '0')
    }

    it('aggregates and cleans up data older than two days', async () => {
      // need to map participant addresses to ids first
      const participantsMap = await mapParticipantsToIds(pgClient, new Set(['0x10', '0x20']))
      await pgClient.query(`
        INSERT INTO recent_station_details (day, accepted_measurement_count, total_measurement_count, station_id, participant_id)
        VALUES
        (CURRENT_DATE - INTERVAL '3 days', 10, 20, 1, $1),
        (CURRENT_DATE - INTERVAL '3 days', 5, 10, 2, $2);
      `, [participantsMap.get('0x10'), participantsMap.get('0x20')])
      await pgClient.query(`
        INSERT INTO recent_participant_subnets (day, participant_id, subnet)
        VALUES
        (CURRENT_DATE - INTERVAL '3 days', $1, 'subnet1'),
        (CURRENT_DATE - INTERVAL '3 days', $2, 'subnet2');
      `, [participantsMap.get('0x10'), participantsMap.get('0x20')])

      await aggregateAndCleanUpRecentData(pgClient)
      await assertDailySummary()
      await aggregateAndCleanUpRecentData(pgClient) // Run again and check that nothing changes
      await assertDailySummary()
    })
  })

  describe('updateMonthlyActiveStationCount', () => {
    const assertCorrectMonthlyActiveStationCount = async () => {
      const { rows } = await pgClient.query(`
        SELECT * FROM monthly_active_station_count
        WHERE month = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
      `)
      assert.strictEqual(rows.length, 1)
      assert.strictEqual(rows[0].station_count, 2)

      const recentStationsCount = await pgClient.query(`
        SELECT COUNT(*) FROM recent_active_stations
        WHERE day >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
          AND day < DATE_TRUNC('month', CURRENT_DATE)
      `)
      assert.strictEqual(recentStationsCount.rows[0].count, '0')
    }

    it('updates monthly active station count for the previous month', async () => {
      await pgClient.query(`
        INSERT INTO recent_active_stations (day, station_id)
        VALUES
        (DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') + INTERVAL '1 day', 1),
        (DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') + INTERVAL '2 days', 2);
      `)

      await updateMonthlyActiveStationCount(pgClient)
      await assertCorrectMonthlyActiveStationCount()
      await updateMonthlyActiveStationCount(pgClient) // Run again and check that nothing changes
      await assertCorrectMonthlyActiveStationCount()
    })
  })

  describe('daily_participants', () => {
    it('submits daily_participants data for today', async () => {
      /** @type {Measurement[]} */
      const allMeasurements = [
        { ...VALID_MEASUREMENT, participantAddress: '0x10' },
        { ...VALID_MEASUREMENT, participantAddress: '0x10' },
        { ...VALID_MEASUREMENT, participantAddress: '0x20' }
      ]
      await updatePlatformStats(pgClient, allMeasurements)

      const { rows } = await pgClient.query(
        'SELECT day::TEXT, participant_id FROM daily_participants'
      )
      assert.deepStrictEqual(rows, [
        { day: today, participant_id: 1 },
        { day: today, participant_id: 2 }
      ])
    })

    it('creates a new daily_participants row', async () => {
      const participantsMap = await mapParticipantsToIds(pgClient, new Set(['0x10', '0x20']))
      await updateDailyParticipants(pgClient, Array.from(participantsMap.values()))

      const { rows: created } = await pgClient.query(
        'SELECT day::TEXT, participant_id FROM daily_participants'
      )
      assert.deepStrictEqual(created, [
        { day: today, participant_id: 1 },
        { day: today, participant_id: 2 }
      ])
    })

    it('handles participants already seen today', async () => {
      const participantsMap1 = await mapParticipantsToIds(pgClient, new Set(['0x10', '0x20']))
      await updateDailyParticipants(pgClient, Array.from(participantsMap1.values()))

      const participantsMap2 = await mapParticipantsToIds(pgClient, new Set(['0x10', '0x30', '0x20']))
      await updateDailyParticipants(pgClient, Array.from(participantsMap2.values()))

      const { rows: created } = await pgClient.query(
        'SELECT day::TEXT, participant_id FROM daily_participants'
      )
      assert.deepStrictEqual(created, [
        { day: today, participant_id: 1 },
        { day: today, participant_id: 2 },
        { day: today, participant_id: 3 }
      ])
    })

    it('maps new participant addresses to new ids', async () => {
      const participantsMap = await mapParticipantsToIds(pgClient, new Set(['0x10', '0x20']))
      assert.deepStrictEqual(participantsMap, new Map([['0x10', 1], ['0x20', 2]]))
    })

    it('maps existing participants to their existing ids', async () => {
      const participants = new Set(['0x10', '0x20'])
      const first = await mapParticipantsToIds(pgClient, participants)
      assert.deepStrictEqual(first, new Map([['0x10', 1], ['0x20', 2]]))

      participants.add('0x30')
      participants.add('0x40')
      const second = await mapParticipantsToIds(pgClient, participants)
      assert.deepStrictEqual(second, new Map([['0x10', 1], ['0x20', 2], ['0x30', 3], ['0x40', 4]]))
    })

    it('submits daily_participants data for all measurements, not just honest ones', async () => {
      /** @type {Measurement[]} */
      const honestMeasurements = [
        { ...VALID_MEASUREMENT, participantAddress: '0x10' },
        { ...VALID_MEASUREMENT, participantAddress: '0x20' }
      ]

      /** @type {Measurement[]} */
      const allMeasurements = [
        ...honestMeasurements,
        { ...VALID_MEASUREMENT, participantAddress: '0x30', taskingEvaluation: 'TASK_NOT_IN_ROUND' }
      ]

      await updatePlatformStats(pgClient, allMeasurements)

      const { rows } = await pgClient.query(
        'SELECT day::TEXT, participant_id FROM daily_participants ORDER BY participant_id'
      )
      assert.deepStrictEqual(rows, [
        { day: today, participant_id: 1 },
        { day: today, participant_id: 2 },
        { day: today, participant_id: 3 }
      ])
    })
  })

  const getCurrentDate = async () => {
    const { rows: [{ today }] } = await pgClient.query('SELECT now()::DATE::TEXT as today')
    return today
  }

  const getYesterdayDate = async () => {
    const { rows: [{ yesterday }] } = await pgClient.query('SELECT now()::DATE - 1 as yesterday')
    return yesterday
  }
})
