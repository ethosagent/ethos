import { describe, expect, it } from 'vitest';
import { autonomyTier, tierMaxRetries } from '../autonomy-tier';
const tiered = { mode: 'tiered' };
describe('autonomyTier', () => {
    it('returns standard for flat policy', () => {
        expect(autonomyTier({ ticketsCompleted: 100, ticketsFailed: 0, ticketsOrphaned: 0 })).toBe('standard');
        expect(autonomyTier({ ticketsCompleted: 100, ticketsFailed: 0, ticketsOrphaned: 0 }, { mode: 'flat' })).toBe('standard');
    });
    it('returns probationary for no history', () => {
        expect(autonomyTier({ ticketsCompleted: 0, ticketsFailed: 0, ticketsOrphaned: 0 }, tiered)).toBe('probationary');
    });
    it('returns probationary for low completed count', () => {
        expect(autonomyTier({ ticketsCompleted: 5, ticketsFailed: 0, ticketsOrphaned: 0 }, tiered)).toBe('probationary');
    });
    it('returns probationary for low ratio', () => {
        expect(autonomyTier({ ticketsCompleted: 15, ticketsFailed: 20, ticketsOrphaned: 0 }, tiered)).toBe('probationary');
    });
    it('returns standard at 10 completed with 0.5+ ratio', () => {
        expect(autonomyTier({ ticketsCompleted: 10, ticketsFailed: 5, ticketsOrphaned: 5 }, tiered)).toBe('standard');
    });
    it('returns trusted at 30 completed with 0.9+ ratio', () => {
        expect(autonomyTier({ ticketsCompleted: 30, ticketsFailed: 1, ticketsOrphaned: 1 }, tiered)).toBe('trusted');
    });
    it('returns standard when 30+ completed but ratio below 0.9', () => {
        expect(autonomyTier({ ticketsCompleted: 30, ticketsFailed: 10, ticketsOrphaned: 0 }, tiered)).toBe('standard');
    });
    it('respects custom thresholds', () => {
        const policy = {
            mode: 'tiered',
            thresholds: { trusted_min_completed: 5, trusted_min_ratio: 0.8 },
        };
        expect(autonomyTier({ ticketsCompleted: 5, ticketsFailed: 1, ticketsOrphaned: 0 }, policy)).toBe('trusted');
    });
    it('returns standard without policy (undefined)', () => {
        expect(autonomyTier({ ticketsCompleted: 0, ticketsFailed: 0, ticketsOrphaned: 0 })).toBe('standard');
    });
});
describe('tierMaxRetries', () => {
    it('probationary gets 1', () => expect(tierMaxRetries('probationary')).toBe(1));
    it('standard gets 3', () => expect(tierMaxRetries('standard')).toBe(3));
    it('trusted gets 5', () => expect(tierMaxRetries('trusted')).toBe(5));
});
