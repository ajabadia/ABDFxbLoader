import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { VfxBanksService } from './vfx-banks.service';
import {
  VfxBanksListRequestDto,
  VfxBanksListResponseDto,
  VfxBankInspectRequestDto,
  VfxBankInspectResponseDto,
  VfxBankCreateRequestDto,
  VfxBankSummaryDto,
  VfxPresetReadRequestDto,
  VfxPresetSaveRequestDto,
  VfxPresetSaveResponseDto,
  VfxPresetDescriptorDto,
  VFX_BANKS_LIST_REQUEST_EXAMPLE,
  VFX_BANKS_LIST_RESPONSE_EXAMPLE,
  VFX_BANK_INSPECT_REQUEST_EXAMPLE,
  VFX_BANK_INSPECT_RESPONSE_EXAMPLE,
  VFX_BANK_CREATE_REQUEST_EXAMPLE,
  VFX_BANK_SUMMARY_EXAMPLE,
  VFX_PRESET_READ_REQUEST_EXAMPLE,
  VFX_PRESET_DESCRIPTOR_EXAMPLE,
  VFX_PRESET_SAVE_REQUEST_EXAMPLE,
  VFX_PRESET_SAVE_RESPONSE_EXAMPLE,
} from './vfx-banks.dto';

@ApiTags('vfx-banks')
@Controller('library/vfx-banks')
export class VfxBanksController {
  constructor(private readonly service: VfxBanksService) {}

  @Post('list')
  @ApiOperation({
    summary: 'Lista los bancos nativos .vfxbank de la librería',
    description: 'Devuelve los bancos encontrados en banks/ con sus presets y plugins referenciados.',
  })
  @ApiOkResponse({ type: VfxBanksListResponseDto, example: VFX_BANKS_LIST_RESPONSE_EXAMPLE })
  async list(@Body() body: VfxBanksListRequestDto): Promise<VfxBanksListResponseDto> {
    return this.service.listBanks(body.libraryRoot);
  }

  @Post('inspect')
  @ApiOperation({
    summary: 'Inspecciona un banco nativo .vfxbank y sus escenas de 4 canales',
    description: 'Devuelve el desglose de escenas .vfxpreset con el mapeo de sus 4 canales de instrumento.',
  })
  @ApiOkResponse({ type: VfxBankInspectResponseDto, example: VFX_BANK_INSPECT_RESPONSE_EXAMPLE })
  async inspect(@Body() body: VfxBankInspectRequestDto): Promise<VfxBankInspectResponseDto> {
    return this.service.inspectBank(body.bankFolder, body.libraryRoot);
  }

  @Post('create')
  @ApiOperation({
    summary: 'Crea un nuevo banco nativo .vfxbank vacío',
  })
  @ApiOkResponse({ type: VfxBankSummaryDto, example: VFX_BANK_SUMMARY_EXAMPLE })
  async create(@Body() body: VfxBankCreateRequestDto): Promise<VfxBankSummaryDto> {
    return this.service.createBank(body.name, body.index, body.libraryRoot);
  }

  @Post('preset/read')
  @ApiOperation({
    summary: 'Lee el descriptor completo de una escena de 4 canales',
  })
  @ApiOkResponse({ type: VfxPresetDescriptorDto, example: VFX_PRESET_DESCRIPTOR_EXAMPLE })
  async readPreset(@Body() body: VfxPresetReadRequestDto): Promise<VfxPresetDescriptorDto> {
    return this.service.readPreset(body.bankFolder, body.presetFolder, body.libraryRoot);
  }

  @Post('preset/save')
  @ApiOperation({
    summary: 'Crea o actualiza una escena de 4 canales en un banco',
  })
  @ApiOkResponse({ type: VfxPresetSaveResponseDto, example: VFX_PRESET_SAVE_RESPONSE_EXAMPLE })
  async savePreset(@Body() body: VfxPresetSaveRequestDto): Promise<VfxPresetSaveResponseDto> {
    return this.service.savePreset(
      body.bankFolder,
      body.presetFolder,
      body.index,
      body.preset,
      body.libraryRoot,
    );
  }
}
