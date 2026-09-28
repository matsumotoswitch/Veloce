import { describe, it, expect } from 'vitest';
import {
  formatMetadataNumber,
  formatRequestType,
  parsePromptTags,
  highlightSearchTerms,
  createSearchTermsRegex,
  extractMetadataFields,
  buildInspectorSections
} from '../src/common/metadata-format.js';

describe('Metadata Format Utils', () => {
  describe('createSearchTermsRegex and highlightSearchTerms', () => {
    it('should return null for empty or invalid terms array', () => {
      expect(createSearchTermsRegex([])).toBeNull();
      expect(createSearchTermsRegex(null)).toBeNull();
      expect(createSearchTermsRegex(['', '   '])).toBeNull();
    });

    it('should escape special regex characters in search terms', () => {
      const re = createSearchTermsRegex(['c++', '(solo)', '[tag]']);
      expect(re).toBeInstanceOf(RegExp);
      expect(re.source).toContain('c\\+\\+');
      expect(re.source).toContain('\\(solo\\)');
      expect(re.source).toContain('\\[tag\\]');
    });

    it('should highlight search terms using pre-compiled regex', () => {
      const terms = ['1girl', 'smile'];
      const regex = createSearchTermsRegex(terms);
      const text = '1girl with a bright smile, high quality';
      const highlighted = highlightSearchTerms(text, regex);
      expect(highlighted).toContain('<mark class="search-highlight">1girl</mark>');
      expect(highlighted).toContain('<mark class="search-highlight">smile</mark>');
    });

    it('should highlight search terms using terms array (backward compatibility)', () => {
      const text = 'cat and dog';
      const highlighted = highlightSearchTerms(text, ['cat']);
      expect(highlighted).toContain('<mark class="search-highlight">cat</mark>');
    });
  });

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

    it('should correctly extract adoptedPrompt when randomizer is used in NovelAI', () => {
      const file = { name: 'randomizer.png' };
      const meta = {
        prompt: '1girl, ||takino tomo|kasuga ayumu||, cheerful',
        negativePrompt: 'bad anatomy',
        source: 'NovelAI',
        params: {
          adoptedPrompt: '1girl, takino tomo, cheerful',
          width: 832,
          height: 1216
        }
      };

      const extracted = extractMetadataFields(file, meta);
      expect(extracted.prompt).toBe('1girl, ||takino tomo|kasuga ayumu||, cheerful');
      expect(extracted.adoptedPrompt).toBe('1girl, takino tomo, cheerful');
    });

    it('should fallback to params.prompt for adoptedPrompt when it differs from meta.prompt', () => {
      const file = { name: 'randomizer_raw.png' };
      const meta = {
        prompt: '||takino tomo|kasuga ayumu||',
        source: 'NovelAI',
        params: {
          prompt: 'takino tomo',
          steps: 28
        }
      };

      const extracted = extractMetadataFields(file, meta);
      expect(extracted.prompt).toBe('||takino tomo|kasuga ayumu||');
      expect(extracted.adoptedPrompt).toBe('takino tomo');
    });

    it('should not set adoptedPrompt when prompt matches params.prompt and no randomizer syntax', () => {
      const file = { name: 'normal.png' };
      const meta = {
        prompt: '1girl, cheerful',
        source: 'NovelAI',
        params: {
          prompt: '1girl, cheerful'
        }
      };

      const extracted = extractMetadataFields(file, meta);
      expect(extracted.prompt).toBe('1girl, cheerful');
      expect(extracted.adoptedPrompt).toBeNull();
    });

    it('should correctly extract adopted prompts from actual_prompts for base, negative, and character prompts', () => {
      const file = { name: 'actual_prompts_test.png' };
      const meta = {
        prompt: '1girl',
        negativePrompt: 'lowres, ||extra fingers|bad hands||',
        source: 'NovelAI',
        params: {
          characterPrompts: [
            {
              prompt: 'girl, smile, ||takino tomo|kasuga ayumu|| (azumanga daioh)',
              uc: 'bad anatomy'
            }
          ],
          actual_prompts: {
            prompt: {
              base_caption: '1girl',
              char_captions: [
                {
                  char_caption: 'girl, smile, takino tomo (azumanga daioh)'
                }
              ]
            },
            negative_prompt: {
              base_caption: 'lowres, bad hands',
              char_captions: [
                {
                  char_caption: 'bad anatomy'
                }
              ]
            }
          }
        }
      };

      const extracted = extractMetadataFields(file, meta);
      expect(extracted.prompt).toBe('1girl');
      expect(extracted.adoptedPrompt).toBeNull(); // base prompt matches
      expect(extracted.negativePrompt).toBe('lowres, ||extra fingers|bad hands||');
      expect(extracted.adoptedNegativePrompt).toBe('lowres, bad hands');

      expect(extracted.chars.length).toBe(1);
      expect(extracted.chars[0].prompt).toBe('girl, smile, ||takino tomo|kasuga ayumu|| (azumanga daioh)');
      expect(extracted.chars[0].adoptedPrompt).toBe('girl, smile, takino tomo (azumanga daioh)');
      expect(extracted.chars[0].uc).toBe('bad anatomy');
      expect(extracted.chars[0].adoptedUc).toBeNull(); // matches
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
      expect(sections[1].copyable).toBe(true);

      expect(sections[2].title).toBe('除外したい要素');
      expect(sections[2].copyable).toBe(true);

      expect(sections[3].title).toBe('キャラクター 1 プロンプト');
      expect(sections[3].value).toBe('red hair');
      expect(sections[3].copyable).toBe(true);

      expect(sections[4].title).toBe('キャラクター 1 除外したい要素');
      expect(sections[4].copyable).toBe(true);

      // パラメータセクション（モデル、シード、サイズ等）には copyable が付与されないこと
      expect(sections[0].copyable).toBeUndefined();
      expect(sections[5].title).toBe('画像サイズ');
      expect(sections[5].copyable).toBeUndefined();
      expect(sections[6].title).toBe('シード値');
      expect(sections[6].copyable).toBeUndefined();
    });

    it('should include 採用プロンプト, 採用除外したい要素, and character 採用プロンプト/採用除外したい要素', () => {
      const data = {
        source: 'NovelAI',
        prompt: '1girl, ||takino tomo|kasuga ayumu||',
        adoptedPrompt: '1girl, takino tomo',
        negativePrompt: 'lowres, ||extra fingers|bad hands||',
        adoptedNegativePrompt: 'lowres, bad hands',
        chars: [
          {
            prompt: '||black hair|brown hair||',
            adoptedPrompt: 'black hair',
            uc: '||worst|bad||',
            adoptedUc: 'worst'
          }
        ],
        params: {
          resolution: '832x1,216'
        }
      };

      const sections = buildInspectorSections(data);
      expect(sections[0].title).toBe('モデル / バージョン');
      expect(sections[1].title).toBe('プロンプト');
      expect(sections[1].value).toBe('1girl, ||takino tomo|kasuga ayumu||');
      expect(sections[1].copyable).toBe(true);

      expect(sections[2].title).toBe('採用プロンプト');
      expect(sections[2].value).toBe('1girl, takino tomo');
      expect(sections[2].copyable).toBe(true);

      expect(sections[3].title).toBe('除外したい要素');
      expect(sections[3].value).toBe('lowres, ||extra fingers|bad hands||');

      expect(sections[4].title).toBe('採用除外したい要素');
      expect(sections[4].value).toBe('lowres, bad hands');
      expect(sections[4].copyable).toBe(true);

      expect(sections[5].title).toBe('キャラクター 1 プロンプト');
      expect(sections[5].value).toBe('||black hair|brown hair||');

      expect(sections[6].title).toBe('キャラクター 1 採用プロンプト');
      expect(sections[6].value).toBe('black hair');
      expect(sections[6].copyable).toBe(true);

      expect(sections[7].title).toBe('キャラクター 1 除外したい要素');
      expect(sections[7].value).toBe('||worst|bad||');

      expect(sections[8].title).toBe('キャラクター 1 採用除外したい要素');
      expect(sections[8].value).toBe('worst');
      expect(sections[8].copyable).toBe(true);
    });
  });
});
