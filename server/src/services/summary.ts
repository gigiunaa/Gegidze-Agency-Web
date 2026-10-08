import type { EmailDraft, NoteSection } from '../../../shared/types';
import type { DatabaseService } from './database';
import { config } from '../config';
import { generateJson, type GeminiOptions } from './gemini';

export interface Notes {
  overview: string;
  sections: NoteSection[];
  nextSteps: string[];
  emailDraft?: EmailDraft;
}

// Shorter transcripts (a test call, a hello) don't need notes
export const MIN_WORDS_FOR_NOTES = 40;

const NOTES_SCHEMA = {
  type: 'OBJECT',
  properties: {
    overview: { type: 'STRING' },
    sections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { heading: { type: 'STRING' }, text: { type: 'STRING' } },
        required: ['heading', 'text'],
      },
    },
    nextSteps: { type: 'ARRAY', items: { type: 'STRING' } },
    isClientMeeting: { type: 'BOOLEAN' },
    emailDraft: {
      type: 'OBJECT',
      properties: { subject: { type: 'STRING' }, body: { type: 'STRING' } },
      required: ['subject', 'body'],
    },
  },
  required: ['overview', 'sections', 'nextSteps', 'isClientMeeting', 'emailDraft'],
};

const NOTES_PROMPT = [
  'შენ ბიზნეს-შეხვედრების ჩანაწერებს წერ. ქვემოთ მოცემულია ზარის ტრანსკრიპტი (ხაზის დასაწყისში კვადრატულ ფრჩხილებში მოლაპარაკის სახელია).',
  'დაწერე შეხვედრის ჩანაწერები ქართულ ენაზე, მხოლოდ იმის საფუძველზე, რაც ტრანსკრიპტშია. არაფერი გამოიგონო და არაფერი დაამატო.',
  'ფორმატი:',
  '- overview: 2–3 წინადადება — რაზე იყო საუბარი და რა შედეგით დასრულდა.',
  '- sections: 3–6 თემა. heading — მოკლე სათაური (2–4 სიტყვა); text — 1–3 წინადადება ფაქტებით: რიცხვები, ვადები, სახელები, გადაწყვეტილებები.',
  '- nextSteps: შეთანხმებული შემდეგი ნაბიჯები, ვინ და როდის. თუ არ იყო — ცარიელი სია.',
  '- isClientMeeting: true, თუ ზარზე იყო კლიენტი ან გარე კომპანიის წარმომადგენელი. false, თუ მხოლოდ ჩვენი გუნდის წევრები საუბრობდნენ ერთმანეთში.',
  '- emailDraft: წერილი კლიენტს ზარის შემდეგ. თუ isClientMeeting არის false, მაინც შეავსე, მაგრამ ის არ გამოჩნდება.',
  '  წერილს წერს {{AUTHOR}}, პირველ პირში, და ხელს აწერს მხოლოდ სახელით.',
  '  ადრესატს მიმართე მეორე პირში, თავაზიანი „თქვენ“-ით. ადრესატზე არასდროს ილაპარაკო მესამე პირში და მის სახელს ტექსტში ნუ გაიმეორებ.',
  '  მისალმება: თუ ადრესატი ერთია — „გამარჯობა, [სახელი],“. თუ რამდენიმეა — უბრალოდ „გამარჯობა,“. ერთი სახელი ორჯერ არ დაწერო.',
  '  სტრუქტურა: ერთი წინადადება მადლობა; ერთი-ორი წინადადება რაზე შევთანხმდით; შემდეგ ნაბიჯები — რას გავაკეთებ მე და რას თქვენ, ვადებით.',
  '  მაქსიმუმ 90 სიტყვა. შეხვედრის ჩანაწერებს ნუ გაიმეორებ — მხოლოდ ის, რაც კლიენტს სჭირდება შემდეგი ნაბიჯისთვის.',
  '  ფასები, ვადები და სახელები ზუსტად გადმოიტანე. არაფერი გამოიგონო.',
  '  subject — კონკრეტული, 4–8 სიტყვა; არა „შეხვედრის შეჯამება“.',
  '  body დაყავი ხაზებად: მისალმება ცალკე ხაზზე, შემდეგ ცარიელი ხაზი, ტექსტი, ცარიელი ხაზი, და ბოლოს „პატივისცემით,“ და სახელი ცალ-ცალკე ხაზზე.',
  'პროდუქტების და კომპანიების სახელები (Google Ads, Zoho, WhatsApp) ლათინურად დატოვე. ტექსტში მხოლოდ ქართული ასოები გამოიყენე, სხვა ანბანის ასოები არ აურიო.',
  '',
  'ტრანსკრიპტი:',
].join('\n');

// `author` is whose account the meeting belongs to. Left to itself the model picks a name out of
// the transcript and writes as the wrong person — one draft came back signed by the customer and
// addressed to the very person who was meant to be sending it.
export async function buildNotes(
  transcript: string,
  options: Pick<GeminiOptions, 'apiKey' | 'model' | 'baseUrl' | 'retryDelayMs'>,
  author = '',
): Promise<Notes> {
  const prompt = NOTES_PROMPT.replaceAll('{{AUTHOR}}', author || 'ის, ვინც ჩვენი მხრიდან იყო ზარზე');
  const result = await generateJson<Partial<Notes> & { isClientMeeting?: boolean }>([{ text: `${prompt}\n${transcript}` }], NOTES_SCHEMA, options);
  return {
    overview: result.overview?.trim() ?? '',
    sections: (result.sections ?? []).filter(s => s.heading && s.text),
    nextSteps: (result.nextSteps ?? []).filter(Boolean),
    // A draft with no subject or no body is worse than none: it looks ready to send and is not.
    // An internal meeting gets none at all — there is no client to send it to, and the attempt
    // produced a letter to colleagues reciting the minutes back at them.
    ...(result.isClientMeeting !== false && result.emailDraft?.subject?.trim() && result.emailDraft?.body?.trim()
      ? { emailDraft: { subject: result.emailDraft.subject.trim(), body: result.emailDraft.body.trim() } }
      : {}),
  };
}

export class SummaryService {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async generate(transcriptionId: string): Promise<void> {
    const transcription = await this.db.getTranscriptionById(transcriptionId);
    if (!transcription) {
      throw new Error(`Transcription not found: ${transcriptionId}`);
    }

    const wordCount = transcription.fullText.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount < MIN_WORDS_FOR_NOTES) {
      console.log(`Skipping notes — transcript too short (${wordCount} words)`);
      return;
    }

    const meeting = await this.db.getMeeting(transcription.meetingId);
    const owner = meeting ? await this.db.getUserById(meeting.userId) : undefined;

    console.log(`Writing notes for meeting ${transcription.meetingId} (${wordCount} words)...`);
    const notes = await buildNotes(
      transcription.fullText,
      { apiKey: config.geminiApiKey, model: config.transcriptionModel },
      owner?.name ?? '',
    );

    // Someone who already rewrote the follow-up email by hand keeps their version. Writing the
    // notes again ("Try again") would otherwise quietly throw their edits away.
    const edited = await this.db.editedEmailDraft(transcription.meetingId);
    await this.db.createSummary({
      meetingId: transcription.meetingId,
      transcriptionId: transcription.id,
      ...notes,
      ...(edited ? { emailDraft: edited } : {}),
    }, !!edited);
  }
}
