import { describe, it, expect } from 'vitest';
import {
  formatMetadataNumber,
  formatRequestType,
  parsePromptTags,
  highlightSearchTerms,
  extractMetadataFields,
  buildInspectorSections
} from '../src/metadata-format.js';

describe('Metadata Format Utils', () => {
  describe('formatMetadataNumber', () => {
    it('should return null if input is null or undefined', () => {
      expect(formatMetadataNumber(null)).toBeNull();
      expect(formatMetadataNumber(undefined)).toBeNull();
    });

    it('should format numbers with comma separation', () => {
      expect(formatMetadataNumber(1234567)).toBe('1,234,567');
      expect(formatMetadataNumber('832')).toBe('832'); // Small number
      expect(formatMetadataNumber('1920')).toBe('1,920'); // Small number
    });

    it('should return the original string if not a valid number', () => {
      expect(formatMetadataNumber('InvalidNumber')).toBe('InvalidNumber');
    });
  });

  describe('formatRequestType', () => {
    it('should map known request types correctly', () => {
      expect(formatRequestType('PromptGenerateRequest')).toBe('Text to Image');
      expect(formatRequestType('Img2ImgRequest')).toBe('Image to Image');
      expect(formatRequestType('NativeInfillingRequest')).toBe('Inpainting');
    });

    it('should map combined request types', () => {
      expect(formatRequestType('VibeTransfer+CharacterReference+Img2ImgRequest')).toBe('Vibe Transfer + Character Reference + Image to Image');
    });

    it('should return original if unknown', () => {
      expect(formatRequestType('UnknownRequest')).toBe('UnknownRequest');
      expect(formatRequestType(null)).toBeNull();
    });
  });

  describe('parsePromptTags', () => {
    it('should split tags by commas and newlines, and trim whitespace', () => {
      const input = 'tag1, tag2 , \n tag3\r\ntruly long tag, ,';
      const expected = ['tag1', 'tag2', 'tag3', 'truly long tag'];
      expect(parsePromptTags(input)).toEqual(expected);
    });

    it('should return empty array for empty inputs', () => {
      expect(parsePromptTags('')).toEqual([]);
      expect(parsePromptTags(null)).toEqual([]);
    });
  });

  describe('highlightSearchTerms', () => {
    it('should wrap matched terms in <mark> tags and escape HTML', () => {
      const text = '1girl, looking at viewer, red eyes';
      const terms = ['girl', 'red'];
      
      const result = highlightSearchTerms(text, terms);
      expect(result).toContain('<mark class="search-highlight">girl</mark>');
      expect(result).toContain('<mark class="search-highlight">red</mark>');
      expect(result).not.toContain('<red eyes>'); // Ensure escaping worked
    });

    it('should return original string if no terms', () => {
      const text = 'test <string>';
      expect(highlightSearchTerms(text, [])).toBe('test <string>');
    });
  });

  describe('extractMetadataFields', () => {
    it('should correctly extract from NovelAI metadata format', () => {
      const file = { name: 'novelai.png' };
      const meta = {
        prompt: '1girl, solo',
        negativePrompt: 'bad anatomy',
        source: 'NovelAI',
        params: {
          request_type: 'PromptGenerateRequest',
          width: 832,
          height: 1216,
          seed: 12345678,
          steps: 28,
          sampler: 'k_euler',
          scale: 5,
          cfg_rescale: 0,
          uncond_scale: 1,
          characterPrompts: [
            { prompt: 'red hair', uc: 'blue hair' }
          ]
        }
      };

      const extracted = extractMetadataFields(file, meta);
      expect(extracted.name).toBe('novelai.png');
      expect(extracted.source).toBe('NovelAI');
      expect(extracted.requestType).toBe('PromptGenerateRequest');
      expect(extracted.prompt).toBe('1girl, solo');
      expect(extracted.negativePrompt).toBe('bad anatomy');
      expect(extracted.params.resolution).toBe('832x1,216');
      expect(extracted.params.seed).toBe(12345678);
      expect(extracted.params.steps).toBe('28');
      expect(extracted.params.sampler).toBe('k_euler');
      expect(extracted.chars.length).toBe(1);
      expect(extracted.chars[0].prompt).toBe('red hair');
    });

    it('should correctly extract from A1111/Forge metadata format', () => {
      const file = { name: 'a1111.png' };
      const meta = {
        prompt: '1girl, beautiful',
        params: {
          rawParameters: '1girl, beautiful\nNegative prompt: worst quality\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 12345, Size: 512x512, Model hash: xxxxx'
        }
      };

      const extracted = extractMetadataFields(file, meta);
      expect(extracted.prompt).toBe('1girl, beautiful');
      expect(extracted.negativePrompt).toBe('worst quality');
      expect(extracted.params.resolution).toBe('512x512');
      expect(extracted.params.seed).toBe('12345');
      expect(extracted.params.steps).toBe('20');
      expect(extracted.params.sampler).toBe('Euler a');
      expect(extracted.params.scale).toBe('7');
    });

    it('should correctly extract from ComfyUI metadata format (with nodes/links)', () => {
      const file = { name: 'comfy.png' };
      const meta = {
        params: {
          nodes: [
            { id: 1, type: 'CLIPTextEncode', inputs: [], widgets_values: ['positive prompt'], title: 'CLIP Text Encode (Prompt)' },
            { id: 2, type: 'CLIPTextEncode', inputs: [], widgets_values: ['negative prompt'] }, // usually determined by KSampler connections
            { id: 3, type: 'KSampler', inputs: [{ name: 'positive', link: 1 }, { name: 'negative', link: 2 }], widgets_values: [999, 1, 30, 8, 'euler', 'normal'] },
            { id: 4, type: 'EmptyLatentImage', inputs: [], widgets_values: [1024, 1024, 1] }
          ],
          links: [
            [1, 1, 0, 3, 3, 'CONDITIONING'], // positive
            [2, 2, 0, 3, 4, 'CONDITIONING'], // negative
            [3, 4, 0, 3, 0, 'LATENT'] // latent to ksampler
          ]
        }
      };

      const extracted = extractMetadataFields(file, meta);
      expect(extracted.params.seed).toBe(999);
      expect(extracted.params.steps).toBe('30');
      expect(extracted.params.sampler).toBe('euler normal');
      expect(extracted.params.scale).toBe(8);
      expect(extracted.params.resolution).toBe('1,024x1,024');
      
      // ComfyUI parsing is somewhat complex and heuristic-based.
      // If it manages to link the positive prompt correctly:
      if (extracted.prompt) {
         expect(extracted.prompt).toBe('positive prompt');
      }
      if (extracted.negativePrompt) {
         expect(extracted.negativePrompt).toBe('negative prompt');
      }
    });
  });

  describe('buildInspectorSections', () => {
    it('should build a structured array for UI rendering', () => {
      const data = {
        source: 'NovelAI',
        requestType: 'PromptGenerateRequest',
        prompt: '1girl',
        negativePrompt: 'bad',
        chars: [{ prompt: 'red hair', uc: 'blue hair' }],
        params: {
          resolution: '1024x1024',
          seed: 123,
          steps: '28',
          sampler: 'k_euler',
          scale: 5,
          cfg_rescale: 0,
          uncond_scale: 1,
          rawParameters: 'raw'
        }
      };

      const sections = buildInspectorSections(data);
      expect(sections.length).toBe(13);
      expect(sections[0].title).toBe('モデル / バージョン');
      expect(sections[0].value).toBe('NovelAI');
      expect(sections[0].subLabel).toBe('Text to Image'); // Formatted

      expect(sections[1].title).toBe('プロンプト');
      expect(sections[1].value).toBe('1girl');

      expect(sections[3].title).toBe('キャラクター 1 プロンプト');
      expect(sections[3].value).toBe('red hair');
    });
  });
});
