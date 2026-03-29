import { config } from '../config';

interface ZohoRecord {
  id: string;
  Full_Name?: string;
  First_Name?: string;
  Last_Name?: string;
  Email?: string;
  Phone?: string;
  Company?: string;
  Description?: string;
}

interface ZohoDeal {
  id: string;
  Deal_Name?: string;
  Description?: string;
  Contact_Name?: { id: string; name: string };
}

export class ZohoService {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private tokenPromise: Promise<string> | null = null;

  // ── OAuth Token ─────────────────────────────────────────────────────
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    // Prevent concurrent token requests (race condition)
    if (this.tokenPromise) {
      return this.tokenPromise;
    }

    this.tokenPromise = this.fetchNewToken();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  private async fetchNewToken(): Promise<string> {
    const { zohoClientId, zohoClientSecret, zohoRefreshToken } = config;
    if (!zohoClientId || !zohoClientSecret || !zohoRefreshToken) {
      throw new Error('Zoho CRM credentials not configured');
    }

    const params = new URLSearchParams({
      refresh_token: zohoRefreshToken,
      client_id: zohoClientId,
      client_secret: zohoClientSecret,
      grant_type: 'refresh_token',
    });

    const res = await fetch('https://accounts.zoho.eu/oauth/v2/token', {
      method: 'POST',
      body: params,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zoho token error: ${res.status} — ${text}`);
    }

    const data = await res.json() as { error?: string; access_token: string; expires_in: number };
    if (data.error) {
      throw new Error(`Zoho token error: ${data.error}`);
    }

    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // refresh 1 min early
    console.log('Zoho access token obtained');
    return this.accessToken!;
  }

  // ── API Request ─────────────────────────────────────────────────────
  private async api(endpoint: string, method = 'GET', body?: unknown): Promise<any> {
    const token = await this.getAccessToken();

    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(`https://www.zohoapis.eu/crm/v2${endpoint}`, options);

    // 204 = no content (empty search results)
    if (res.status === 204) {
      return { data: [] };
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zoho API error: ${res.status} — ${text}`);
    }

    return res.json();
  }

  // ── Search Leads + Contacts ─────────────────────────────────────────
  async searchLeads(query: string): Promise<ZohoRecord[]> {
    const mapRecords = (data: any): ZohoRecord[] =>
      (data.data || []).map((r: any) => ({
        id: r.id,
        Full_Name: r.Full_Name,
        First_Name: r.First_Name,
        Last_Name: r.Last_Name,
        Email: r.Email,
        Phone: r.Phone,
        Company: r.Company,
        Description: r.Description,
      }));

    const results: ZohoRecord[] = [];
    const seenIds = new Set<string>();

    const addUnique = (records: ZohoRecord[]) => {
      for (const r of records) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          results.push(r);
        }
      }
    };

    // Single word search covers Leads + Contacts in 2 requests
    // word= searches across all fields (name, email, company, phone)
    const modules = ['Leads', 'Contacts'] as const;
    for (const mod of modules) {
      try {
        const data = await this.api(`/${mod}/search?word=${encodeURIComponent(query)}&per_page=10`);
        const records = mapRecords(data);
        addUnique(records);
        console.log(`Zoho word search (${mod}): ${records.length} results`);
        if (results.length >= 10) break;
      } catch (err) {
        console.error(`Zoho word search (${mod}) failed:`, err);
      }
    }

    console.log(`Zoho search for "${query}": ${results.length} total results`);
    return results;
  }

  // ── Search Deals by Lead/Contact ────────────────────────────────────
  async getDealsByLead(recordId: string): Promise<ZohoDeal[]> {
    const mapDeals = (data: any): ZohoDeal[] =>
      (data.data || []).map((d: any) => ({
        id: d.id,
        Deal_Name: d.Deal_Name,
        Description: d.Description,
      }));

    // Try Leads relationship first
    try {
      const data = await this.api(`/Leads/${recordId}/Deals`);
      const deals = mapDeals(data);
      if (deals.length > 0) return deals;
    } catch {
      // Not a lead or no deals
    }

    // Try Contacts relationship
    try {
      const data = await this.api(`/Contacts/${recordId}/Deals`);
      return mapDeals(data);
    } catch {
      return [];
    }
  }

  // ── Update Lead Description ─────────────────────────────────────────
  async updateLeadDescription(leadId: string, summary: string, append = true): Promise<void> {
    let description = summary;

    if (append) {
      try {
        const data = await this.api(`/Leads/${leadId}`);
        const existing = data.data?.[0]?.Description || '';
        if (existing) {
          description = `${existing}\n\n---\n\n${summary}`;
        }
      } catch {
        // If we can't read existing, just write new
      }
    }

    await this.api('/Leads', 'PUT', {
      data: [{ id: leadId, Description: description }],
    });

    console.log(`Updated Lead ${leadId} description`);
  }

  // ── Update Deal Description ─────────────────────────────────────────
  async updateDealDescription(dealId: string, summary: string, append = true): Promise<void> {
    let description = summary;

    if (append) {
      try {
        const data = await this.api(`/Deals/${dealId}`);
        const existing = data.data?.[0]?.Description || '';
        if (existing) {
          description = `${existing}\n\n---\n\n${summary}`;
        }
      } catch {
        // If we can't read existing, just write new
      }
    }

    await this.api('/Deals', 'PUT', {
      data: [{ id: dealId, Description: description }],
    });

    console.log(`Updated Deal ${dealId} description`);
  }

  // ── Update Contact Description ──────────────────────────────────────
  async updateContactDescription(contactId: string, summary: string, append = true): Promise<void> {
    let description = summary;

    if (append) {
      try {
        const data = await this.api(`/Contacts/${contactId}`);
        const existing = data.data?.[0]?.Description || '';
        if (existing) {
          description = `${existing}\n\n---\n\n${summary}`;
        }
      } catch {
        // If we can't read existing, just write new
      }
    }

    await this.api('/Contacts', 'PUT', {
      data: [{ id: contactId, Description: description }],
    });

    console.log(`Updated Contact ${contactId} description`);
  }

  // ── Push Summary to Lead/Contact + Deals ──────────────────────────
  async pushSummary(recordId: string, summary: string, meetingTitle: string, date: string): Promise<{ lead: boolean; deals: string[] }> {
    const formattedSummary = `📞 ${meetingTitle}\n📅 ${date}\n\n${summary}`;

    // Try updating as Lead first, then as Contact
    let updated = false;
    let lastError: unknown;
    try {
      await this.updateLeadDescription(recordId, formattedSummary);
      updated = true;
      console.log(`Updated Lead ${recordId}`);
    } catch (err) {
      lastError = err;
      console.log(`Not a Lead, trying Contact...`);
      try {
        await this.updateContactDescription(recordId, formattedSummary);
        updated = true;
        console.log(`Updated Contact ${recordId}`);
      } catch (err2) {
        lastError = err2;
        console.error(`Failed to update record ${recordId}:`, err2);
      }
    }

    if (!updated) {
      throw lastError instanceof Error ? lastError : new Error('Failed to update Lead or Contact in Zoho');
    }

    // Find and update related Deals
    const deals = await this.getDealsByLead(recordId);
    const updatedDeals: string[] = [];

    for (const deal of deals) {
      try {
        await this.updateDealDescription(deal.id, formattedSummary);
        updatedDeals.push(deal.Deal_Name || deal.id);
      } catch (err) {
        console.error(`Failed to update deal ${deal.id}:`, err);
      }
    }

    return { lead: updated, deals: updatedDeals };
  }
}
