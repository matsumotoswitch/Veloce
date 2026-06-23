import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer-state.js';

describe('Rating Feature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset appState rating properties
    appState.ratings = {};
    appState.ratingFilterVal = 0;
    appState.ratingFilterOp = 'gte';
    appState.sortConfig = { key: 'name', asc: true };
    appState.searchQuery = '';
    
    // Mock veloceAPI
    window.veloceAPI = {
      setViewParams: vi.fn().mockResolvedValue(100),
      setRating: vi.fn().mockResolvedValue(true),
      syncRatings: vi.fn()
    };
  });

  it('should initialize with empty ratings', () => {
    expect(appState.ratings).toEqual({});
    expect(appState.ratingFilterVal).toBe(0);
    expect(appState.ratingFilterOp).toBe('gte');
  });

  it('should pass ratingFilterVal and ratingFilterOp to setViewParams', async () => {
    appState.ratingFilterVal = 3;
    appState.ratingFilterOp = 'lte';
    
    const count = await appState.setViewParams();
    
    expect(count).toBe(100);
    expect(window.veloceAPI.setViewParams).toHaveBeenCalledWith('name', true, '', 3, 'lte');
  });
  
  it('should handle rating assignment correctly (mock simulation)', async () => {
    const filePath = 'C:/test/image.png';
    const key = '4';
    const rating = parseInt(key, 10);
    
    // Simulate setting a new rating
    const currentRating = appState.ratings[filePath] || 0;
    const newRating = (rating === currentRating) ? 0 : rating;
    
    appState.ratings[filePath] = newRating;
    await window.veloceAPI.setRating(filePath, newRating);
    
    expect(appState.ratings[filePath]).toBe(4);
    expect(window.veloceAPI.setRating).toHaveBeenCalledWith(filePath, 4);
    
    // Simulate setting the same rating (should clear it)
    const secondKey = '4';
    const secondRating = parseInt(secondKey, 10);
    const currentRating2 = appState.ratings[filePath] || 0;
    const newRating2 = (secondRating === currentRating2) ? 0 : secondRating;
    
    if (newRating2 === 0) {
      delete appState.ratings[filePath];
    } else {
      appState.ratings[filePath] = newRating2;
    }
    await window.veloceAPI.setRating(filePath, newRating2);
    
    expect(appState.ratings[filePath]).toBeUndefined();
    expect(window.veloceAPI.setRating).toHaveBeenCalledWith(filePath, 0);
  });
});
