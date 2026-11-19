/**
 * Default watchlist. Three source classes, weighted differently by the scorer:
 *   1 = first-party (labs and model accounts): launch news, primary claims
 *   2 = researchers and sharp commentators: analysis, measurements, pushback
 *   3 = builders and tooling: practice, releases, what actually works
 *
 * Handles verified against the public endpoints on 2026-11-09. Several
 * accounts whose public timeline payload only carries their all-time top
 * posts are served through the profile-page fallback; dead handles
 * (MetaAI, xai, CohereForAI, soumithchint) are left out.
 */

export const DEFAULT_ACCOUNTS = [
  { handle: 'OpenAI', tier: 1, label: 'OpenAI' },
  { handle: 'AnthropicAI', tier: 1, label: 'Anthropic' },
  { handle: 'GoogleDeepMind', tier: 1, label: 'Google DeepMind' },
  { handle: 'GoogleAI', tier: 1, label: 'Google AI' },
  { handle: 'MistralAI', tier: 1, label: 'Mistral AI' },
  { handle: 'Alibaba_Qwen', tier: 1, label: 'Qwen' },
  { handle: 'deepseek_ai', tier: 1, label: 'DeepSeek' },

  { handle: 'karpathy', tier: 2, label: 'Andrej Karpathy' },
  { handle: 'simonw', tier: 2, label: 'Simon Willison' },
  { handle: 'fchollet', tier: 2, label: 'François Chollet' },
  { handle: 'DrJimFan', tier: 2, label: 'Jim Fan' },
  { handle: 'emollick', tier: 2, label: 'Ethan Mollick' },
  { handle: '_akhaliq', tier: 2, label: 'AK' },
  { handle: 'arankomatsuzaki', tier: 2, label: 'Aran Komatsuzaki' },
  { handle: 'teortaxesTex', tier: 2, label: 'Teortaxes' },
  { handle: 'scaling01', tier: 2, label: 'scaling01' },
  { handle: 'nearcyan', tier: 2, label: 'near' },
  { handle: 'giffmana', tier: 2, label: 'Lucas Beyer' },
  { handle: 'vikhyatk', tier: 2, label: 'Vikhyat' },

  { handle: 'goodside', tier: 2, label: 'Riley Goodside' },
  { handle: 'petergyang', tier: 2, label: 'Peter Yang' },
  { handle: 'blader', tier: 2, label: 'Siqi Chen' },
  { handle: 'lateinteraction', tier: 2, label: 'Omar Khattab' },
  { handle: 'ylecun', tier: 2, label: 'Yann LeCun' },
  { handle: 'alexalbert__', tier: 2, label: 'Alex Albert' },
  { handle: 'sama', tier: 1, label: 'Sam Altman' },

  { handle: 'swyx', tier: 3, label: 'swyx' },
  { handle: 'mckaywrigley', tier: 3, label: 'Mckay Wrigley' },
  { handle: 'steipete', tier: 3, label: 'Peter Steinberger' },
  { handle: 'hwchase17', tier: 3, label: 'Harrison Chase' },
  { handle: 'langchain', tier: 3, label: 'LangChain' },
  { handle: 'ollama', tier: 3, label: 'Ollama' },
  { handle: 'huggingface', tier: 3, label: 'Hugging Face' },
  { handle: 'skirano', tier: 3, label: 'Pietro Schirano' },
  { handle: 'levelsio', tier: 3, label: 'levelsio' },
]
