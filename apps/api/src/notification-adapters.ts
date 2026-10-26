export interface EmailAdapter {
  deliver(input: { notificationId: string; type: string }): Promise<void>;
}

export class LocalMetadataOnlyEmailAdapter implements EmailAdapter {
  async deliver(input: { notificationId: string; type: string }) {
    console.info("Local email adapter: delivery not configured", {
      notificationId: input.notificationId,
      type: input.type
    });
  }
}

export const emailAdapter: EmailAdapter = new LocalMetadataOnlyEmailAdapter();
