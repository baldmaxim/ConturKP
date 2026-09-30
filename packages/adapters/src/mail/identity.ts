// Идентичность письма в ящике (D-025, AD-07-3; интерпретация И-07-2): внешний ID источника, иначе
// Message-ID, иначе SHA-256 исходного EML. Message-ID глобальным ключом не является: он действует
// только внутри ящика. Тот же Message-ID с другим содержимым — новая ревизия того же письма, а не
// тихая перезапись; побайтный повтор — та же ревизия.

export type MailIdentityKind = 'source_id' | 'message_id' | 'raw_sha256';

export interface IMailIdentity {
  kind: MailIdentityKind;
  value: string;
}

export const mailIdentity = (o: { sourceItemId?: string | null; messageId: string | null; rawSha256: string }): IMailIdentity => {
  if (o.sourceItemId) return { kind: 'source_id', value: o.sourceItemId };
  if (o.messageId) return { kind: 'message_id', value: o.messageId };
  return { kind: 'raw_sha256', value: o.rawSha256 };
};

// Ключ логической коммуникации (И-07-1): копии одного письма в разных ящиках объединяются по
// Message-ID; письмо без Message-ID — отдельная коммуникация.
export const communicationGroupKey = (messageId: string | null): string | null => messageId;
