import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsString,
  IsOptional,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ASSIGNABLE_ROLES } from 'src/auth/roles';

/** Um vínculo de painel: o perfil que a pessoa tem em uma igreja. */
export class ChurchRoleDto {
  @ApiProperty({ example: 'church-id-uuid' })
  @IsString()
  churchId: string;

  @ApiProperty({ example: 2, description: '2 = admin, 3 = financeiro' })
  @IsInt()
  role: number;
}

export class UserDTO {
  @ApiProperty({
    example: 'url',
    description: 'Imagem',
  })
  @IsString()
  @IsOptional()
  profilePhotoUrl?: string;

  @ApiProperty({
    example: 'Gold',
    description: 'Nome do badge',
  })
  @IsString()
  @IsOptional()
  badgeName?: string;

  @ApiProperty({
    example: 'uluizfelipe@gmail.com',
    description: 'E-mail',
  })
  @IsEmail()
  @IsOptional()
  email: string;

  @ApiProperty({
    example: 'Felipe Queiroz',
    description: 'Nome do usuario',
  })
  @IsString()
  @IsOptional()
  @MinLength(5)
  fullName: string;

  @ApiProperty({
    example: '123456',
    description: 'Senha',
  })
  @IsString()
  @IsOptional()
  password?: string;

  @ApiProperty({
    example: '10647111114',
  })
  @IsString()
  @MinLength(11)
  @MaxLength(11)
  @IsOptional()
  cpf: string;

  @ApiProperty({
    example: '1993-11-20',
  })
  @IsString()
  @IsOptional()
  birthday: Date;

  @ApiProperty({
    example: 5,
    description:
      'Permissão - 1: Super Admin, 2: Admin, 3: Financeiro, 5: Usuário',
    enum: ASSIGNABLE_ROLES,
  })
  @IsInt()
  @IsIn(ASSIGNABLE_ROLES)
  @IsOptional()
  role?: number;

  @ApiProperty({
    example: '84987445761',
  })
  @IsString()
  @MinLength(11)
  @MaxLength(11)
  @IsOptional()
  cellphone: string;

  @ApiProperty({
    example: true,
  })
  @IsBoolean()
  @IsOptional()
  diabetes: boolean;

  @ApiProperty({
    example: true,
  })
  @IsBoolean()
  @IsOptional()
  hypertensive: boolean;

  @ApiProperty({
    example: 'Pastor',
    description: 'Profissão',
  })
  @IsString()
  @MinLength(2)
  @IsOptional()
  profession: string;

  @ApiProperty({
    example: 'Parque das arvores',
    description: 'Bairro',
  })
  @IsString()
  @IsOptional()
  neighborhood: string;

  @ApiProperty({
    example: 'Natal',
    description: 'Cidade',
  })
  @IsString()
  @MinLength(2)
  @IsOptional()
  city: string;

  @ApiProperty({
    example: 'RN',
    description: 'Estado',
  })
  @IsString()
  @MinLength(2)
  @IsOptional()
  state: string;

  @ApiProperty({
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  worker: boolean;

  @ApiProperty({
    example: '84987445761',
  })
  @IsString()
  @IsOptional()
  @MinLength(11)
  @MaxLength(11)
  emergencyContact?: string;

  @ApiProperty({
    example: 'Felipe',
    description: 'Quem indicou?',
  })
  @IsString()
  @IsOptional()
  indicatedBy?: string;

  @ApiProperty({
    example: 'Pastor',
    description: 'Cargo de liderança',
  })
  @IsString()
  @IsOptional()
  @MinLength(2)
  leadershipPosition?: string;

  @IsString()
  @IsOptional()
  eventId?: string;

  @ApiProperty({
    example: 'Evangelico',
    description: 'Deve conter a religiao do usuario',
  })
  @IsOptional()
  religion?: string;

  @ApiProperty({
    example: 'Alergico',
    description: 'Este campo deve conter todas as observacoes sobre o usuario',
  })
  @IsString()
  @IsOptional()
  notes?: string;

  /**
   * Lente da lista de usuários: o super admin pede uma igreja e a lista
   * responde como se ele fosse admin dela. Não é campo de gravação.
   */
  @ApiProperty({
    example: 'church-id-uuid',
    description: 'Filtra a lista pela igreja (só o super admin usa)',
    required: false,
  })
  @IsString()
  @IsOptional()
  churchId?: string;

  @ApiProperty({
    description:
      'Vínculos de painel: em qual igreja a pessoa é admin (2) e em qual é ' +
      'financeiro (3). A mesma pessoa pode ter perfis diferentes em igrejas ' +
      'diferentes. Lista vazia tira a pessoa do painel.',
    required: false,
    type: 'array',
    items: {
      type: 'object',
      properties: {
        churchId: { type: 'string' },
        role: { type: 'number', example: 2 },
      },
    },
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChurchRoleDto)
  churchRoles?: ChurchRoleDto[];
}
