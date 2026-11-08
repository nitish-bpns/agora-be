import { beforeEach, describe, expect, it } from 'vitest';
import { Organization, Facility } from '../../src/modules/warehouse/org.models.js';
import { registerDevice, updateDeviceStatus, addHardwareModel, listHardwareModels, addManualMeasurement, listIntegrationContracts } from '../../src/modules/warehouse/integration.service.js';
import { Device, Measurement } from '../../src/modules/warehouse/integration.models.js';
import { clearDatabase } from './test-db.js';

const orgId = 'ORG-H1';
const facilityId = 'FAC-H1';

async function seed(): Promise<void> {
  await Organization.create({ organizationId: orgId, name: 'Org' });
  await Facility.create({ facilityId, organizationId: orgId, name: 'Facility', code: 'F1' });
}

beforeEach(async () => {
  await clearDatabase();
  await seed();
});

describe('hardware readiness (Phase 2 prep)', () => {
  it('registers planned devices without claiming connectivity', async () => {
    const device = await registerDevice({ organizationId: orgId, facilityId, category: 'MoistureMeter', manufacturer: 'Acme', model: 'MM-1', serialNumber: 'SN-1', config: { bluetooth: true } }, 'USR-H1');
    expect((device as { status: string }).status).toBe('Planned');
    const saved = await Device.findOne({ serialNumber: 'SN-1' }).lean();
    expect(saved?.category).toBe('MoistureMeter');
    expect(saved?.lastSuccessfulCommAt).toBeNull();
  });

  it('refuses to mark a device Connected without a real integration', async () => {
    const device = await registerDevice({ organizationId: orgId, facilityId, category: 'EnvironmentalSensor', manufacturer: 'Acme', model: 'TH-1', serialNumber: 'SN-2' }, 'USR-H1');
    const deviceId = String((device as { deviceId: string }).deviceId);
    await expect(updateDeviceStatus({ organizationId: orgId, deviceId, status: 'Connected' }, 'USR-H1')).rejects.toThrow('real integration');
    await expect(updateDeviceStatus({ organizationId: orgId, deviceId, status: 'ConfiguredNotConnected' }, 'USR-H1')).resolves.toBeTruthy();
  });

  it('supports multiple candidate hardware models with verification statuses', async () => {
    await addHardwareModel({ category: 'MoistureMeter', manufacturer: 'Acme', model: 'MM-100', supportedMeasurands: ['MoisturePct'], communicationInterfaces: ['Bluetooth'], verificationStatus: 'ManufacturerDocumented' });
    await addHardwareModel({ category: 'MoistureMeter', manufacturer: 'Beta', model: 'BM-200', supportedMeasurands: ['MoisturePct'], communicationInterfaces: ['USB'], verificationStatus: 'NotYetVerified' });
    const models = await listHardwareModels('MoistureMeter');
    expect(models).toHaveLength(2);
    const statuses = models.map((m) => (m as { verificationStatus: string }).verificationStatus).sort();
    expect(statuses).toEqual(['ManufacturerDocumented', 'NotYetVerified'].sort());
  });

  it('manual measurement creates a provable record, device-specific', async () => {
    await addManualMeasurement({ organizationId: orgId, facilityId, measurementType: 'MoisturePct', value: 16.5, unit: '%', operatorId: 'USR-H1' }, 'USR-H1');
    const measurements = await Measurement.find({ organizationId: orgId }).lean();
    expect(measurements).toHaveLength(1);
    expect(measurements[0]?.dataSource).toBe('Manual');
    expect(measurements[0]?.value).toBe(16.5);
  });

  it('manual measurement is rejected for a connected device', async () => {
    const device = await registerDevice({ organizationId: orgId, facilityId, category: 'MoistureMeter', manufacturer: 'Acme', model: 'MM-1', serialNumber: 'SN-3' }, 'USR-H1');
    await Device.updateOne({ deviceId: (device as { deviceId: string }).deviceId }, { $set: { status: 'Connected' } });
    await expect(addManualMeasurement({ organizationId: orgId, facilityId, deviceId: (device as { deviceId: string }).deviceId, measurementType: 'MoisturePct', value: 15, unit: '%' }, 'USR-H1')).rejects.toThrow();
  });

  it('exposes adapter contracts for future integrations', async () => {
    const contracts = await listIntegrationContracts();
    const ids = contracts.map((c) => (c as { id: string }).id).sort();
    expect(ids).toEqual(['CameraAdapter', 'EnvironmentalSensorAdapter', 'MoistureMeterAdapter', 'VehicleTrackerAdapter'].sort());
    const moisture = contracts.find((c) => (c as { id: string }).id === 'MoistureMeterAdapter') as { capabilities: string[]; phase: number };
    expect(moisture.capabilities).toContain('readMoisture');
    expect(moisture.phase).toBe(2);
  });
});
