/** Safe product states only. Never expose raw transport errors or credentials. */
export class IdentitySourceReviewRequired extends Error {
  constructor() { super('Review and activate the configured identity source before publishing.'); }
}
export type PublicationAsset = {assetId: string; topicBase: string};
