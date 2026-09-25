import { ApiProperty } from '@nestjs/swagger';
import { EventStatus, EventType, MinorApprovalStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { QUANTIDADE_MAXIMA_POR_ITEM } from '../event-products';

class RoleDto {
  @IsOptional()
  @IsString()
  groupId: string;

  @IsOptional()
  @IsString()
  id?: string;

  @IsNumber()
  price: number;

  @IsString()
  description: string;
}

class GroupRoleDto {
  @IsString()
  @IsOptional()
  eventId?: string;

  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  name: string;

  @IsInt()
  capacity: number;

  @ApiProperty({
    example: 'https://chat.whatsapp.com/xxxxxxxxxxxxxxxxxxxx',
    description: 'Link do grupo de whatsapp deste grupo (opcional)',
    required: false,
  })
  @IsOptional()
  @IsString()
  link?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoleDto)
  roles: RoleDto[];
}
class ProductVariantDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  name: string;

  @ApiProperty({
    example: 30,
    description: 'Unidades à venda. Nulo ou ausente é sem limite.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number | null;
}

class ProductDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiProperty({ example: 60, description: 'Preço único para as variantes' })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiProperty({
    example: ['data:image/webp;base64,UklGR...'],
    description:
      'Até 5 fotos como data URL base64 (PNG, JPG ou WebP); a primeira é a capa. Ausente mantém as atuais; nulo ou lista vazia remove todas.',
    required: false,
    nullable: true,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5, { message: 'Um produto pode ter até 5 fotos' })
  @IsString({ each: true })
  images?: string[] | null;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProductVariantDto)
  variants: ProductVariantDto[];
}

export class EventDto {
  @ApiProperty({
    example: 'Retiro 2023',
    description: 'Nome do evento',
  })
  @IsString()
  name: string;

  @ApiProperty({
    example: 'https://chat.whatsapp.com/xxxxxxxxxxxxxxxxxxxx',
    description: 'Link do grupo do whatsapp',
  })
  @IsString()
  @IsOptional()
  groupLink: string;

  @ApiProperty({
    enum: EventStatus,
    example: EventStatus.ACTIVE,
    description:
      'Status do evento. TEST só aparece na área do usuário para admin e super admin',
  })
  @Transform(({ value }) => {
    // multipart manda tudo como texto; o booleano antigo ainda chega de
    // clientes que não foram atualizados
    if (value === true || value === 'true') return EventStatus.ACTIVE;
    if (value === false || value === 'false') return EventStatus.INACTIVE;
    return typeof value === 'string' ? value.toUpperCase() : value;
  })
  @IsEnum(EventStatus)
  status: EventStatus;

  @ApiProperty({
    example: '2023-02-17',
    description: 'Data que devera acontecer o evento',
  })
  @IsDateString()
  startDate: Date;

  @ApiProperty({
    example: '2023-02-17',
    description: 'Data que devera encerrar o evento',
  })
  @IsDateString()
  endDate: Date;

  @ApiProperty({
    description: 'Grupos de regras do evento',
    example: [
      {
        id: 'uuid-v4',
        name: 'Grupo 1',
        capacity: 100,
        roles: [
          {
            id: 'uuid-v4',
            price: 100.0,
            description: 'Descrição da regra 1',
          },
          {
            price: 150.0,
            description: 'Descrição da regra 2',
          },
        ],
      },
    ],
  })
  @Transform(({ value }) => {
    // Se for string, faz JSON.parse primeiro
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return [];
      }
    }
    // Agora trata como array e converte para instâncias de GroupRoleDto
    if (Array.isArray(value)) {
      const transformed = value.map((groupRole) =>
        Object.assign(new GroupRoleDto(), groupRole),
      );
      const transformedWithTypes = transformed.map((groupRole) => {
        groupRole.roles = groupRole.roles.map((role) =>
          Object.assign(new RoleDto(), role),
        );
        return groupRole;
      });
      return transformedWithTypes;
    }
    return [];
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GroupRoleDto)
  groupRoles?: GroupRoleDto[];

  @ApiProperty({
    description:
      'Produtos vendidos na inscrição. Na edição, ausente não mexe nos produtos; lista vazia remove todos os que ainda não foram vendidos.',
    required: false,
    example: [
      {
        name: 'Camisa do evento',
        price: 60,
        variants: [{ name: 'P', stock: 30 }, { name: 'M' }],
      },
    ],
  })
  // multipart manda o JSON como texto; mesmo tratamento de `groupRoles`
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return value;
      }
    }

    if (!Array.isArray(value)) return value;

    return value.map((produto) => {
      const dto = Object.assign(new ProductDto(), produto);
      dto.variants = (produto?.variants ?? []).map((variante) =>
        Object.assign(new ProductVariantDto(), variante),
      );
      return dto;
    });
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductDto)
  products?: ProductDto[];

  @ApiProperty({
    example: { local: 'Auditório Principal', address: 'Rua XYZ, 123' },
    description: 'Dados adicionais do evento',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? JSON.parse(value) : value,
  )
  @IsObject()
  @IsOptional()
  data: Object;
  @ApiProperty({
    example: 'CURSILHO',
    description: 'Tipo do evento',
  })
  @IsString()
  type: EventType;

  @ApiProperty({
    description: 'File da logo do evento',
    type: 'string',
    format: 'binary',
    required: false,
  })
  @IsOptional()
  logoFile?: Express.Multer.File;

  @ApiProperty({
    description: 'File da capa do evento',
    type: 'string',
    format: 'binary',
    required: false,
  })
  @IsOptional()
  coverFile?: Express.Multer.File;

  @ApiProperty({
    description:
      'Termo de autorização em branco, para pais/responsáveis de menores de 16 anos baixarem, assinarem e reenviarem',
    type: 'string',
    format: 'binary',
    required: false,
  })
  @IsOptional()
  termFile?: Express.Multer.File;

  @ApiProperty({
    example: 'church-id-uuid',
    description: 'ID da church/igreja (obrigatório para SuperAdmin)',
    required: false,
  })
  @IsOptional()
  @IsString()
  churchId?: string;
}
export class roleEventDto {
  @ApiProperty({
    description: 'IDs das regras de inscrição atribuídas ao usuário no evento',
    example: ['uuid-v4', 'uuid-v4'],
  })
  @IsString({ each: true })
  roleRegistrationId: string[];

  @ApiProperty({
    example: true,
    description:
      'Aceite do termo do evento (`data.registrationTerm`). Obrigatório para quem se inscreve em evento que tem termo; ignorado nos demais.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  acceptedTerms?: boolean;
}

class ProductPurchaseItemDto {
  @ApiProperty({ example: 'uuid-da-variante' })
  @IsString()
  variantId: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: QUANTIDADE_MAXIMA_POR_ITEM })
  @IsInt()
  @Min(1)
  @Max(QUANTIDADE_MAXIMA_POR_ITEM)
  quantity: number;
}

export class ProductPurchaseDto {
  @ApiProperty({
    required: false,
    default: false,
    description:
      'Verdadeiro na oferta logo depois da inscrição: os itens entram no pagamento do ingresso se ele ainda estiver em aberto. Falso (ou ausente) cria uma compra separada.',
  })
  @IsOptional()
  @IsBoolean()
  attachToRegistration?: boolean;

  @ApiProperty({
    type: [ProductPurchaseItemDto],
    description: 'Variantes escolhidas e quantas unidades de cada',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProductPurchaseItemDto)
  items: ProductPurchaseItemDto[];
}
export class GuardianApprovalDto {
  @ApiProperty({
    enum: [MinorApprovalStatus.APPROVED, MinorApprovalStatus.REJECTED],
    example: MinorApprovalStatus.APPROVED,
  })
  @IsIn([MinorApprovalStatus.APPROVED, MinorApprovalStatus.REJECTED])
  status: MinorApprovalStatus;

  @ApiProperty({
    example: 'Termo ilegível, favor reenviar uma foto mais nítida',
    description: 'Motivo da recusa — obrigatório quando status é REJECTED',
    required: false,
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
