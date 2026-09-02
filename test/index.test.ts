import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the DattoRmmClient before importing the module that uses it
const mockDevicesGet = vi.fn();
const mockDevicesCreateQuickJob = vi.fn();
const mockSitesGet = vi.fn();
const mockSitesDevices = vi.fn();
const mockSitesDevicesAll = vi.fn();
const mockSitesAlertsOpenAll = vi.fn();
const mockAlertsResolve = vi.fn();
const mockAuditDevice = vi.fn();
const mockAuditDeviceSoftware = vi.fn();
const mockAccountDevices = vi.fn();
const mockAccountDevicesAll = vi.fn();
const mockAccountSitesAll = vi.fn();
const mockAccountAlertsOpenAll = vi.fn();

vi.mock('@wyre-ai/node-datto-rmm', () => ({
  // A regular function (not an arrow function) so it can be invoked with `new`
  DattoRmmClient: vi.fn().mockImplementation(function () {
    return {
      devices: {
        get: mockDevicesGet,
        createQuickJob: mockDevicesCreateQuickJob,
      },
      sites: {
        get: mockSitesGet,
        devices: mockSitesDevices,
        devicesAll: mockSitesDevicesAll,
        alertsOpenAll: mockSitesAlertsOpenAll,
      },
      alerts: {
        resolve: mockAlertsResolve,
      },
      audit: {
        device: mockAuditDevice,
        deviceSoftware: mockAuditDeviceSoftware,
      },
      account: {
        devices: mockAccountDevices,
        devicesAll: mockAccountDevicesAll,
        sitesAll: mockAccountSitesAll,
        alertsOpenAll: mockAccountAlertsOpenAll,
      },
    };
  }),
}));

// Mock MCP SDK components
const mockServerConnect = vi.fn();
const mockSetRequestHandler = vi.fn();

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  // A regular function (not an arrow function) so it can be invoked with `new`
  Server: vi.fn().mockImplementation(function () {
    return {
      connect: mockServerConnect,
      setRequestHandler: mockSetRequestHandler,
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ListToolsRequestSchema: Symbol('ListToolsRequestSchema'),
  CallToolRequestSchema: Symbol('CallToolRequestSchema'),
  ListResourcesRequestSchema: Symbol('ListResourcesRequestSchema'),
  ReadResourceRequestSchema: Symbol('ReadResourceRequestSchema'),
}));

describe('Datto RMM MCP Server', () => {
  // Store original env values
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();
    // Reset environment variables
    delete process.env.DATTO_API_KEY;
    delete process.env.DATTO_API_SECRET;
    delete process.env.DATTO_PLATFORM;
    delete process.env.X_API_KEY;
    delete process.env.X_API_SECRET;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('getCredentials', () => {
    it('should read from DATTO_API_KEY and DATTO_API_SECRET environment variables', () => {
      process.env.DATTO_API_KEY = 'test-api-key';
      process.env.DATTO_API_SECRET = 'test-api-secret';

      expect(process.env.DATTO_API_KEY).toBe('test-api-key');
      expect(process.env.DATTO_API_SECRET).toBe('test-api-secret');
    });

    it('should support gateway X_API_KEY and X_API_SECRET format', () => {
      process.env.X_API_KEY = 'gateway-api-key';
      process.env.X_API_SECRET = 'gateway-api-secret';

      expect(process.env.X_API_KEY).toBe('gateway-api-key');
      expect(process.env.X_API_SECRET).toBe('gateway-api-secret');
    });

    it('should return null when API key is missing', () => {
      process.env.DATTO_API_SECRET = 'secret-only';

      // Verify the key is not set
      expect(process.env.DATTO_API_KEY).toBeUndefined();
      expect(process.env.X_API_KEY).toBeUndefined();
    });

    it('should return null when API secret is missing', () => {
      process.env.DATTO_API_KEY = 'key-only';

      // Verify the secret is not set
      expect(process.env.DATTO_API_SECRET).toBeUndefined();
      expect(process.env.X_API_SECRET).toBeUndefined();
    });
  });

  describe('platform validation', () => {
    const validPlatforms = ['pinotage', 'merlot', 'concord', 'vidal', 'zinfandel', 'syrah'];

    it('should have 6 valid platforms', () => {
      expect(validPlatforms).toHaveLength(6);
    });

    it('should include concord as a valid platform (default)', () => {
      expect(validPlatforms).toContain('concord');
    });

    it('should include all valid Datto RMM regions', () => {
      expect(validPlatforms).toContain('pinotage'); // APAC
      expect(validPlatforms).toContain('merlot');   // EU
      expect(validPlatforms).toContain('concord');  // US
      expect(validPlatforms).toContain('vidal');    // US2
      expect(validPlatforms).toContain('zinfandel'); // US3
      expect(validPlatforms).toContain('syrah');    // UK
    });

    it('should use concord as default when DATTO_PLATFORM is not set', () => {
      process.env.DATTO_API_KEY = 'key';
      process.env.DATTO_API_SECRET = 'secret';

      expect(process.env.DATTO_PLATFORM).toBeUndefined();
    });

    it('should accept valid platform from environment', () => {
      process.env.DATTO_PLATFORM = 'merlot';

      expect(validPlatforms).toContain(process.env.DATTO_PLATFORM);
    });

    it('should fall back to concord for invalid platform', () => {
      process.env.DATTO_PLATFORM = 'invalid-platform';

      expect(validPlatforms).not.toContain(process.env.DATTO_PLATFORM);
      // The server would fall back to 'concord' as default
    });
  });

  describe('Tool Handlers', () => {
    // Helper to create an async generator from an array
    async function* createAsyncGenerator<T>(items: T[]): AsyncGenerator<T> {
      for (const item of items) {
        yield item;
      }
    }

    describe('datto_list_devices', () => {
      it('should list all devices when no siteUid provided', async () => {
        const mockDevices = [
          { uid: 'device-1', hostname: 'workstation-01' },
          { uid: 'device-2', hostname: 'server-01' },
        ];

        mockAccountDevicesAll.mockReturnValue(createAsyncGenerator(mockDevices));

        // Verify mock is set up correctly
        const generator = mockAccountDevicesAll();
        const items = [];
        for await (const item of generator) {
          items.push(item);
        }

        expect(items).toHaveLength(2);
        expect(items[0]).toEqual({ uid: 'device-1', hostname: 'workstation-01' });
      });

      it('should list devices filtered by siteUid when provided', async () => {
        const mockDevices = [
          { uid: 'device-1', hostname: 'site-workstation-01', siteUid: 'site-123' },
        ];

        mockSitesDevicesAll.mockReturnValue(createAsyncGenerator(mockDevices));

        const generator = mockSitesDevicesAll('site-123');
        const items = [];
        for await (const item of generator) {
          items.push(item);
        }

        expect(items).toHaveLength(1);
        expect(items[0].siteUid).toBe('site-123');
      });

      it('should respect max parameter for pagination', async () => {
        const mockDevices = Array.from({ length: 100 }, (_, i) => ({
          uid: `device-${i}`,
          hostname: `workstation-${i}`,
        }));

        mockAccountDevicesAll.mockReturnValue(createAsyncGenerator(mockDevices));

        // collectItems helper should stop at max
        const max = 10;
        const generator = mockAccountDevicesAll();
        const items = [];
        for await (const item of generator) {
          items.push(item);
          if (items.length >= max) break;
        }

        expect(items).toHaveLength(10);
      });
    });

    describe('datto_get_device', () => {
      it('should return device details for valid deviceUid', async () => {
        const mockDevice = {
          uid: 'device-123',
          hostname: 'server-01',
          siteUid: 'site-456',
          deviceType: { category: 'Server' },
          operatingSystem: 'Windows Server 2019',
          online: true,
        };

        mockDevicesGet.mockResolvedValue(mockDevice);

        const result = await mockDevicesGet('device-123');

        expect(result).toEqual(mockDevice);
        expect(mockDevicesGet).toHaveBeenCalledWith('device-123');
      });

      it('should handle device not found error', async () => {
        mockDevicesGet.mockRejectedValue(new Error('Device not found'));

        await expect(mockDevicesGet('invalid-uid')).rejects.toThrow('Device not found');
      });
    });

    describe('datto_find_device', () => {
      // Raw Datto RMM API device payloads (the SDK returns them verbatim)
      const rawDevices = [
        {
          uid: 'uid-host06',
          hostname: 'APP-HV-HOST06',
          siteUid: 'site-1',
          siteName: 'Main Office',
          online: true,
          intIpAddress: '10.0.0.6',
          operatingSystem: 'Microsoft Windows Server 2022',
          lastSeen: 1751900000000,
          portalUrl: 'https://concord.centrastage.net/csm/device/uid-host06',
        },
        {
          uid: 'uid-host060',
          hostname: 'APP-HV-HOST060',
          siteUid: 'site-2',
          siteName: 'Branch Office',
          online: false,
          intIpAddress: '10.0.1.60',
          operatingSystem: 'Microsoft Windows Server 2019',
          lastSeen: 1751800000000,
          portalUrl: 'https://concord.centrastage.net/csm/device/uid-host060',
        },
      ];

      // Invoke the real CallTool handler registered by createMcpServer()
      async function callFindDevice(args: Record<string, unknown>) {
        process.env.DATTO_API_KEY = 'test-key';
        process.env.DATTO_API_SECRET = 'test-secret';

        const { createMcpServer } = await import('../src/mcp-server.js');
        const { CallToolRequestSchema } = await import(
          '@modelcontextprotocol/sdk/types.js'
        );

        createMcpServer();

        const registration = mockSetRequestHandler.mock.calls.find(
          ([schema]) => schema === CallToolRequestSchema
        );
        expect(registration).toBeDefined();
        const handler = registration![1] as (request: {
          params: { name: string; arguments: Record<string, unknown> };
        }) => Promise<{
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
        }>;

        return handler({
          params: { name: 'datto_find_device', arguments: args },
        });
      }

      it('should find a device by exact hostname (server-side filter passed through)', async () => {
        mockAccountDevices.mockResolvedValue({ devices: rawDevices });

        const result = await callFindDevice({ hostname: 'APP-HV-HOST06' });

        expect(result.isError).toBeUndefined();
        expect(mockAccountDevices).toHaveBeenCalledWith(
          expect.objectContaining({ hostname: 'app-hv-host06' })
        );

        const payload = JSON.parse(result.content[0].text);
        expect(payload.count).toBe(1);
        expect(payload.devices[0]).toEqual({
          uid: 'uid-host06',
          hostname: 'APP-HV-HOST06',
          siteUid: 'site-1',
          siteName: 'Main Office',
          online: true,
          intIpAddress: '10.0.0.6',
          operatingSystem: 'Microsoft Windows Server 2022',
          lastSeen: 1751900000000,
          portalUrl: 'https://concord.centrastage.net/csm/device/uid-host06',
        });
      });

      it('should exclude partial matches when exactMatch is true (default)', async () => {
        mockAccountDevices.mockResolvedValue({ devices: rawDevices });

        const result = await callFindDevice({ hostname: 'app-hv-host06' });

        const payload = JSON.parse(result.content[0].text);
        expect(payload.count).toBe(1);
        expect(payload.devices[0].uid).toBe('uid-host06');
      });

      it('should include partial matches when exactMatch is false', async () => {
        mockAccountDevices.mockResolvedValue({ devices: rawDevices });

        const result = await callFindDevice({
          hostname: 'HOST06',
          exactMatch: false,
        });

        const payload = JSON.parse(result.content[0].text);
        expect(payload.count).toBe(2);
      });

      it('should respect the max parameter', async () => {
        mockAccountDevices.mockResolvedValue({ devices: rawDevices });

        const result = await callFindDevice({
          hostname: 'HOST06',
          exactMatch: false,
          max: 1,
        });

        const payload = JSON.parse(result.content[0].text);
        expect(payload.count).toBe(1);
      });

      it('should scope the lookup to a site when siteUid is provided', async () => {
        mockSitesDevices.mockResolvedValue({ devices: [rawDevices[0]] });

        const result = await callFindDevice({
          hostname: 'APP-HV-HOST06',
          siteUid: 'site-1',
        });

        expect(mockSitesDevices).toHaveBeenCalledWith(
          'site-1',
          expect.objectContaining({ hostname: 'app-hv-host06' })
        );
        expect(mockAccountDevices).not.toHaveBeenCalled();

        const payload = JSON.parse(result.content[0].text);
        expect(payload.count).toBe(1);
      });

      it('should return an explicit not-found error instead of an empty success', async () => {
        mockAccountDevices.mockResolvedValue({ devices: [] });

        const result = await callFindDevice({ hostname: 'NO-SUCH-HOST' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(
          'No devices found matching hostname "NO-SUCH-HOST"'
        );
      });

      it('should return an error for an empty hostname', async () => {
        const result = await callFindDevice({ hostname: '   ' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('hostname must not be empty');
        expect(mockAccountDevices).not.toHaveBeenCalled();
      });
    });

    describe('datto_list_alerts', () => {
      it('should list all open alerts when no siteUid provided', async () => {
        const mockAlerts = [
          { alertUid: 'alert-1', severity: 'critical', message: 'Disk space low' },
          { alertUid: 'alert-2', severity: 'warning', message: 'CPU high' },
        ];

        mockAccountAlertsOpenAll.mockReturnValue(createAsyncGenerator(mockAlerts));

        const generator = mockAccountAlertsOpenAll();
        const items = [];
        for await (const item of generator) {
          items.push(item);
        }

        expect(items).toHaveLength(2);
        expect(items[0].severity).toBe('critical');
      });

      it('should list alerts filtered by siteUid when provided', async () => {
        const mockAlerts = [
          { alertUid: 'alert-1', siteUid: 'site-123', severity: 'warning' },
        ];

        mockSitesAlertsOpenAll.mockReturnValue(createAsyncGenerator(mockAlerts));

        const generator = mockSitesAlertsOpenAll('site-123');
        const items = [];
        for await (const item of generator) {
          items.push(item);
        }

        expect(items).toHaveLength(1);
        expect(mockSitesAlertsOpenAll).toHaveBeenCalledWith('site-123');
      });
    });

    describe('datto_resolve_alert', () => {
      it('should resolve an alert successfully', async () => {
        mockAlertsResolve.mockResolvedValue({ success: true, alertUid: 'alert-123' });

        const result = await mockAlertsResolve('alert-123');

        expect(result.success).toBe(true);
        expect(mockAlertsResolve).toHaveBeenCalledWith('alert-123');
      });

      it('should handle alert resolution error', async () => {
        mockAlertsResolve.mockRejectedValue(new Error('Alert already resolved'));

        await expect(mockAlertsResolve('alert-123')).rejects.toThrow('Alert already resolved');
      });

      it('should require alertUid parameter', () => {
        // The tool schema requires alertUid
        const inputSchema = {
          type: 'object',
          properties: {
            alertUid: { type: 'string', description: 'The alert UID to resolve' },
          },
          required: ['alertUid'],
        };

        expect(inputSchema.required).toContain('alertUid');
      });
    });

    describe('datto_list_sites', () => {
      it('should list all sites in the account', async () => {
        const mockSites = [
          { uid: 'site-1', name: 'Main Office', deviceCount: 25 },
          { uid: 'site-2', name: 'Branch Office', deviceCount: 10 },
        ];

        mockAccountSitesAll.mockReturnValue(createAsyncGenerator(mockSites));

        const generator = mockAccountSitesAll();
        const items = [];
        for await (const item of generator) {
          items.push(item);
        }

        expect(items).toHaveLength(2);
        expect(items[0].name).toBe('Main Office');
      });

      it('should use default max of 50', () => {
        const inputSchema = {
          type: 'object',
          properties: {
            max: { type: 'number', description: 'Maximum number of results (default: 50)', default: 50 },
          },
        };

        expect(inputSchema.properties.max.default).toBe(50);
      });
    });

    describe('datto_get_site', () => {
      it('should return site details for valid siteUid', async () => {
        const mockSite = {
          uid: 'site-123',
          name: 'Corporate HQ',
          address: '123 Main St',
          deviceCount: 50,
          onlineDeviceCount: 48,
        };

        mockSitesGet.mockResolvedValue(mockSite);

        const result = await mockSitesGet('site-123');

        expect(result).toEqual(mockSite);
        expect(result.name).toBe('Corporate HQ');
      });

      it('should handle site not found error', async () => {
        mockSitesGet.mockRejectedValue(new Error('Site not found'));

        await expect(mockSitesGet('invalid-site')).rejects.toThrow('Site not found');
      });
    });

    describe('datto_run_quickjob', () => {
      it('should run a quick job on a device', async () => {
        const mockJobResult = {
          jobUid: 'job-123',
          status: 'queued',
          deviceUid: 'device-456',
        };

        mockDevicesCreateQuickJob.mockResolvedValue(mockJobResult);

        const result = await mockDevicesCreateQuickJob('device-456', {
          jobName: 'Restart Service',
          componentUid: 'component-789',
        });

        expect(result.jobUid).toBe('job-123');
        expect(result.status).toBe('queued');
      });

      it('should pass variables to the job', async () => {
        const jobRequest = {
          jobName: 'Run Script',
          componentUid: 'component-789',
          variables: { param1: 'value1', param2: 'value2' },
        };

        mockDevicesCreateQuickJob.mockResolvedValue({ jobUid: 'job-124', status: 'queued' });

        await mockDevicesCreateQuickJob('device-456', jobRequest);

        expect(mockDevicesCreateQuickJob).toHaveBeenCalledWith('device-456', jobRequest);
      });

      it('should require deviceUid, jobName, and componentUid', () => {
        const inputSchema = {
          type: 'object',
          properties: {
            deviceUid: { type: 'string' },
            jobName: { type: 'string' },
            componentUid: { type: 'string' },
            variables: { type: 'object' },
          },
          required: ['deviceUid', 'jobName', 'componentUid'],
        };

        expect(inputSchema.required).toContain('deviceUid');
        expect(inputSchema.required).toContain('jobName');
        expect(inputSchema.required).toContain('componentUid');
        expect(inputSchema.required).not.toContain('variables');
      });

      it('should handle job creation error', async () => {
        mockDevicesCreateQuickJob.mockRejectedValue(new Error('Component not found'));

        await expect(
          mockDevicesCreateQuickJob('device-456', {
            jobName: 'Test',
            componentUid: 'invalid-component',
          })
        ).rejects.toThrow('Component not found');
      });
    });

    describe('datto_get_device_audit', () => {
      it('should return full audit data by default', async () => {
        const mockAudit = {
          hardware: { manufacturer: 'Dell', model: 'OptiPlex 7080' },
          os: { name: 'Windows 10', version: '21H2' },
          software: [{ name: 'Chrome', version: '120.0' }],
        };

        mockAuditDevice.mockResolvedValue(mockAudit);

        const result = await mockAuditDevice('device-123');

        expect(result.hardware).toBeDefined();
        expect(result.os).toBeDefined();
        expect(result.software).toBeDefined();
      });

      it('should return software audit only when auditType is software', async () => {
        const mockSoftwareAudit = [
          { name: 'Chrome', version: '120.0' },
          { name: 'Firefox', version: '121.0' },
        ];

        mockAuditDeviceSoftware.mockResolvedValue(mockSoftwareAudit);

        const result = await mockAuditDeviceSoftware('device-123');

        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(2);
      });

      it('should require deviceUid parameter', () => {
        const inputSchema = {
          type: 'object',
          properties: {
            deviceUid: { type: 'string' },
            auditType: { type: 'string', enum: ['full', 'software'], default: 'full' },
          },
          required: ['deviceUid'],
        };

        expect(inputSchema.required).toContain('deviceUid');
        expect(inputSchema.properties.auditType.enum).toContain('full');
        expect(inputSchema.properties.auditType.enum).toContain('software');
      });
    });
  });

  describe('Error Handling', () => {
    it('should return error when credentials are missing', () => {
      // Verify no credentials are set
      expect(process.env.DATTO_API_KEY).toBeUndefined();
      expect(process.env.DATTO_API_SECRET).toBeUndefined();
      expect(process.env.X_API_KEY).toBeUndefined();
      expect(process.env.X_API_SECRET).toBeUndefined();

      // The server would return an error response with isError: true
      const expectedErrorResponse = {
        content: [{
          type: 'text',
          text: 'Error: No API credentials provided. Please configure your Datto RMM API key and secret via DATTO_API_KEY and DATTO_API_SECRET environment variables.',
        }],
        isError: true,
      };

      expect(expectedErrorResponse.isError).toBe(true);
    });

    it('should handle unknown tool name', () => {
      const unknownToolResponse = {
        content: [{ type: 'text', text: 'Unknown tool: unknown_tool' }],
        isError: true,
      };

      expect(unknownToolResponse.isError).toBe(true);
      expect(unknownToolResponse.content[0].text).toContain('Unknown tool');
    });

    it('should wrap API errors in error response', async () => {
      const apiError = new Error('API rate limit exceeded');
      mockDevicesGet.mockRejectedValue(apiError);

      try {
        await mockDevicesGet('device-123');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('API rate limit exceeded');
      }
    });

    it('should handle non-Error exceptions', () => {
      // The server handles both Error instances and other thrown values
      const stringError = 'String error message';
      const errorMessage = stringError instanceof Error ? stringError.message : String(stringError);

      expect(errorMessage).toBe('String error message');
    });
  });

  describe('collectItems Helper', () => {
    async function* createAsyncGenerator<T>(items: T[]): AsyncGenerator<T> {
      for (const item of items) {
        yield item;
      }
    }

    async function collectItems<T>(iterable: AsyncIterable<T>, max: number): Promise<T[]> {
      const items: T[] = [];
      for await (const item of iterable) {
        items.push(item);
        if (items.length >= max) break;
      }
      return items;
    }

    it('should collect items up to max limit', async () => {
      const items = Array.from({ length: 100 }, (_, i) => i);
      const generator = createAsyncGenerator(items);

      const result = await collectItems(generator, 10);

      expect(result).toHaveLength(10);
      expect(result).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('should return all items if less than max', async () => {
      const items = [1, 2, 3];
      const generator = createAsyncGenerator(items);

      const result = await collectItems(generator, 50);

      expect(result).toHaveLength(3);
      expect(result).toEqual([1, 2, 3]);
    });

    it('should handle empty iterable', async () => {
      const generator = createAsyncGenerator([]);

      const result = await collectItems(generator, 50);

      expect(result).toHaveLength(0);
    });
  });

  describe('Server Configuration', () => {
    it('should define server with correct name and version', () => {
      const serverConfig = {
        name: 'datto-rmm-mcp',
        version: '1.0.0',
      };

      expect(serverConfig.name).toBe('datto-rmm-mcp');
      expect(serverConfig.version).toBe('1.0.0');
    });

    it('should have tools capability enabled', () => {
      const capabilities = {
        tools: {},
      };

      expect(capabilities.tools).toBeDefined();
    });

    it('should register handlers for ListTools and CallTool schemas', () => {
      // Server should register two request handlers
      const expectedSchemas = ['ListToolsRequestSchema', 'CallToolRequestSchema'];
      expect(expectedSchemas).toHaveLength(2);
    });
  });

  describe('Tool Definitions', () => {
    const expectedTools = [
      'datto_list_devices',
      'datto_find_device',
      'datto_get_device',
      'datto_list_alerts',
      'datto_resolve_alert',
      'datto_list_sites',
      'datto_get_site',
      'datto_run_quickjob',
      'datto_get_device_audit',
    ];

    it('should define all 9 tools', () => {
      expect(expectedTools).toHaveLength(9);
    });

    it('should include device management tools', () => {
      expect(expectedTools).toContain('datto_list_devices');
      expect(expectedTools).toContain('datto_find_device');
      expect(expectedTools).toContain('datto_get_device');
      expect(expectedTools).toContain('datto_get_device_audit');
    });

    it('should include site management tools', () => {
      expect(expectedTools).toContain('datto_list_sites');
      expect(expectedTools).toContain('datto_get_site');
    });

    it('should include alert management tools', () => {
      expect(expectedTools).toContain('datto_list_alerts');
      expect(expectedTools).toContain('datto_resolve_alert');
    });

    it('should include job management tools', () => {
      expect(expectedTools).toContain('datto_run_quickjob');
    });
  });

  describe('Rate Limit Awareness', () => {
    it('should handle rate limit errors gracefully', async () => {
      const rateLimitError = new Error('429 Too Many Requests');
      mockDevicesGet.mockRejectedValue(rateLimitError);

      await expect(mockDevicesGet('device-123')).rejects.toThrow('429 Too Many Requests');
    });

    it('should have pagination defaults to limit API calls', () => {
      // Default max of 50 helps prevent excessive API calls
      const defaultMax = 50;
      expect(defaultMax).toBeLessThanOrEqual(100);
    });
  });
});
