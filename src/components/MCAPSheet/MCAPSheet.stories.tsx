import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { MCAPSheet } from './MCAPSheet';
import { LOG_TIME_COLUMN } from '../../lib/mcap/worksheet';
import type { TopicWorksheet } from './types';

const sampleWorkbook: TopicWorksheet[] = [
  {
    topic: '/imu',
    columns: [LOG_TIME_COLUMN, 'header.frame_id', 'linear_acceleration.x', 'linear_acceleration.y'],
    rows: [
      {
        [LOG_TIME_COLUMN]: '1000000000',
        'header.frame_id': 'imu_link_front',
        'linear_acceleration.x': 0.3,
        'linear_acceleration.y': -0.1,
      },
      {
        [LOG_TIME_COLUMN]: '2000000000',
        'header.frame_id': 'imu_link_rear',
        'linear_acceleration.x': 0.2,
        'linear_acceleration.y': -0.2,
      },
    ],
  },
  {
    topic: '/gps',
    columns: [LOG_TIME_COLUMN, 'fix.latitude', 'fix.longitude'],
    rows: [
      {
        [LOG_TIME_COLUMN]: '3000000000',
        'fix.latitude': 37.789,
        'fix.longitude': -122.401,
      },
    ],
  },
];

const meta = {
  component: MCAPSheet,
  args: {
    url: 'https://example.com/sample.mcap',
    dataLoader: async () => sampleWorkbook,
    height: 420,
  },
  tags: ['ai-generated'],
} satisfies Meta<typeof MCAPSheet>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithColumnFilter: Story = {
  play: async ({ canvas, userEvent }) => {
    // linear_acceleration.x is numeric, so it gets a min/max range filter.
    const minInput = await canvas.findByLabelText('Min linear_acceleration.x');
    await userEvent.type(minInput, '0.25');
    await expect(canvas.getByText('imu_link_front')).toBeVisible();
    await expect(canvas.queryByText('imu_link_rear')).toBeNull();
  },
};

export const CssCheck: Story = {
  play: async ({ canvas }) => {
    const tab = await canvas.findByRole('button', { name: /\/imu/ });
    await expect(getComputedStyle(tab).backgroundColor).toBe('rgb(255, 255, 255)');
  },
};
