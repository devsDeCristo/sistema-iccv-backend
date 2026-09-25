import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { UserDTO } from './user.dto';

/**
 * O próprio cadastro, pela tela de perfil. Os campos são os do cadastro; o que
 * a pessoa não pode mudar sobre si mesma é recusado em `UserService.updateMe`.
 */
export class UpdateMeDto extends UserDTO {
  /** Só é exigida para trocar o e-mail — ver `updateMe` */
  @ApiPropertyOptional({
    description: 'Senha atual, para confirmar a troca de e-mail',
  })
  @IsOptional()
  @IsString()
  @MaxLength(72)
  currentPassword?: string;
}
