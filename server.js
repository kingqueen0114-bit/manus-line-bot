const express = require('express');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');

const app = express();

// 環境変数から設定を読み込み
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken
});

// Gemini API初期化
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Google API認証（サービスアカウント）
let auth;
try {
  const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  auth = new google.auth.GoogleAuth({
    credentials: serviceAccountKey,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/tasks'
    ]
  } );
  console.log('Google Auth initialized successfully');
} catch (error) {
  console.error('Failed to initialize Google Auth:', error.message);
}

const calendar = google.calendar({ version: 'v3', auth });
const tasks = google.tasks({ version: 'v1', auth });

// LINE User ID
const TARGET_USER_ID = 'Ubd61e83e61bbe07d8df7c6a2a62c0a72';

// ヘルスチェック用エンドポイント
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'MANUS LINE Bot is running on Render.com' });
});

// LINE Webhook
app.post('/webhook', express.json(), async (req, res) => {
  try {
    console.log('Webhook received:', JSON.stringify(req.body));
    
    const events = req.body.events || [];
    
    for (const event of events) {
      await handleEvent(event);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// イベント処理
async function handleEvent(event) {
  console.log('Handling event:', event.type);
  
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userMessage = event.message.text;
  const userId = event.source.userId;

  console.log(`Received message from ${userId}: ${userMessage}`);

  try {
    // Gemini APIで自然言語を解析
    const analysisResult = await analyzeWithGemini(userMessage);
    console.log('Gemini analysis:', analysisResult);

    // 解析結果に基づいて処理
    if (analysisResult.type === 'calendar') {
      await addToCalendar(analysisResult);
      await sendPushMessage(userId, `📅 カレンダーに予定を追加しました\n\n${analysisResult.title}\n${analysisResult.start}`);
    } else if (analysisResult.type === 'task') {
      await addToTasks(analysisResult);
      await sendPushMessage(userId, `✅ タスクを追加しました\n\n${analysisResult.title}`);
    } else {
      await sendPushMessage(userId, '申し訳ございません。理解できませんでした。もう一度お試しください。');
    }
  } catch (error) {
    console.error('Error handling event:', error);
    await sendPushMessage(userId, 'エラーが発生しました: ' + error.message);
  }
}

// Gemini APIで自然言語解析（モデル名を修正）
async function analyzeWithGemini(userMessage) {
  const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

  const prompt = `
あなたは日本語の予定・タスク管理アシスタントです。
以下のユーザーメッセージを解析し、JSON形式で返してください。

【解析ルール】
1. 時刻が明示されている場合 → type: "calendar" (カレンダー予定)
2. 時刻が明示されていない場合 → type: "task" (タスク)

【出力JSON形式】
カレンダーの場合:
{
  "type": "calendar",
  "title": "予定のタイトル",
  "start": "2026-01-23T14:00:00+09:00",
  "end": "2026-01-23T15:00:00+09:00",
  "description": "詳細説明"
}

タスクの場合:
{
  "type": "task",
  "title": "タスクのタイトル",
  "due": "2026-01-23T23:59:59+09:00",
  "notes": "メモ"
}

【重要】
- 日時は必ずISO 8601形式（+09:00タイムゾーン）で出力
- 年が省略されている場合は2026年とする
- 時刻が省略されている場合、カレンダーは10:00-11:00、タスクは23:59:59とする
- JSON以外の文字は出力しない

ユーザーメッセージ: ${userMessage}
`;

  const result = await model.generateContent(prompt);
  const responseText = result.response.text();
  
  console.log('Gemini raw response:', responseText);
  
  // JSONを抽出
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse Gemini response');
  }

  return JSON.parse(jsonMatch[0]);
}

// Googleカレンダーに予定追加
async function addToCalendar(eventData) {
  const event = {
    summary: eventData.title,
    description: eventData.description || '',
    start: {
      dateTime: eventData.start,
      timeZone: 'Asia/Tokyo',
    },
    end: {
      dateTime: eventData.end,
      timeZone: 'Asia/Tokyo',
    },
  };

  await calendar.events.insert({
    calendarId: 'primary',
    resource: event,
  });

  console.log('Calendar event added:', event.summary);
}

// Google Tasksにタスク追加
async function addToTasks(taskData) {
  const task = {
    title: taskData.title,
    notes: taskData.notes || '',
    due: taskData.due,
  };

  await tasks.tasks.insert({
    tasklist: '@default',
    resource: task,
  });

  console.log('Task added:', task.title);
}

// LINEメッセージ送信（pushMessageに変更）
async function sendPushMessage(userId, messageText) {
  try {
    await client.pushMessage({
      to: userId,
      messages: [{ type: 'text', text: messageText }],
    });
    console.log('Message sent to:', userId);
  } catch (error) {
    console.error('Failed to send message:', error.message);
    throw error;
  }
}

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('Environment check:');
  console.log('- LINE_CHANNEL_ACCESS_TOKEN:', process.env.LINE_CHANNEL_ACCESS_TOKEN ? 'Set' : 'Not set');
  console.log('- LINE_CHANNEL_SECRET:', process.env.LINE_CHANNEL_SECRET ? 'Set' : 'Not set');
  console.log('- GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'Set' : 'Not set');
  console.log('- GOOGLE_SERVICE_ACCOUNT_JSON:', process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? 'Set' : 'Not set');
});
